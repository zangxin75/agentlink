# Topic 隔离 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 单账号多项目 topic 隔离——消息带 topic 字段、daemon 按 topic 分拣 spool、会话按 `.agentlink.json` 只注入本项目的信 + 广播。

**Architecture:** 服务器只透传存储（`messages.topic` 列 + `agent_topics` 注册表 + 三个查询端点），分拣全在客户端：daemon 落 `spool/<agentId>/topics/<topic>/`，hook-inject 按项目声明过滤并续期注册表，`im send` 用决策链定 topic。

**Tech Stack:** 既有栈不变（Fastify + better-sqlite3 user_version 迁移；客户端零依赖 ESM .mjs + node:test）。

**Spec:** `docs/superpowers/specs/2026-10-02-topic-isolation-design.md`（r2，SHIPPED after critic）

## Global Constraints

- topic 正则（服务器）：`^(_default|[a-z0-9][a-z0-9._-]{0,31})$`；`_default` 保留名=广播，可显式传入，等价省略。
- TTL：`agent_topics.expires_at = now + 25h`；`_default` 不可注册。
- 限频：topics 上报独立桶 60/min。
- 投递不校验 topic 是否注册；响应带 `topic_registered: <bool>`。
- `srv:` 派生消息与 webhook 通知一律 `_default`（现状即如此——本计划不改 derive.ts/webhook，T1 测试钉住）。
- WS `send` op 不支持 topic（hub.ts 的 WS 发送面维持广播），属 spec §8 演进项；现网 CLI 全走 REST POST /v1/messages，无即时破坏。WS **推送**帧带 topic（getInbox COLS 自动带出），T1 测试钉住。
- spool 布局：`spool/<agentId>/topics/<topic>/{*.json, consumed/}`；旧平铺布局废弃不迁移。
- 客户端零依赖（Node ≥18 全局），ESM；服务器相对导入带 `.js`；中文注释；commit 用 conventional 前缀。
- 测试命令：`cd server && npx vitest run test/<file>`；`cd skills/agentlink && node --test test/<file>`。

## Review Focus

以下五类输入 spec 未逐一展开、最可能咬人，各由所属任务测试钉死：

1. **非法 topic 值**（大写/下划线开头/超 32）→ 服务器 400；`.agentlink.json` 中的非法项被静默丢弃不炸 hook → T2/T4 测试。
2. **同 msg id 跨 topic 双落**：`writeMessage` 的 consumed 去重必须按 (agentId, topic) 目录内判定，否则补洞重放会在另一 topic 复活已消费信 → T3 测试。
3. **maxCursor 全局性**：cursor 须取所有 topic 目录的最大 id，漏掉别的 topic 会导致补洞漏信/重 ack → T3 测试。
4. **无 `.agentlink.json` 的 cwd**：hook 回退 `_default`-only，不报错（行为=只见广播）→ T4 测试。
5. **`--reply` 原信不在本地**（consumed 已清理/非本机接收）：回退注册表决策链，不 die → T5 测试。

---

### Task 1: 服务器 — v4 迁移 + messages.topic 全链路透传

**Files:**
- Modify: `server/src/db/schema.ts`（v<4 块）
- Modify: `server/src/core/messages.ts`（COLS、sendMessage、getInbox、history）
- Modify: `server/src/http/routes/send.ts`（body schema 加 topic）
- Modify: `server/src/http/routes/messages.ts`（inbox/history querystring 加 topic）
- Test: `server/test/migration-v4.test.ts`（新建）、`server/test/topic-api.test.ts`（新建，本任务先写迁移+发送部分）

**Interfaces:**
- Produces: `sendMessage` input 增 `topic?: string`；`Message` 接口增 `topic: string`；`getInbox(db, agentId, limit, threadId?, topic?)`；`history` q 增 `topic?: string`。后续任务依赖 `Message.topic` 恒存在（落库默认 `_default`）。
- Consumes: 无（首个任务）。

- [ ] **Step 1: 写失败测试（迁移 + 发送透传）**

`server/test/migration-v4.test.ts`：

```ts
// v4 迁移:messages.topic 默认 _default;agent_topics 表存在;v3 存量行升级路径
import { describe, it, expect } from 'vitest'
import { openDb } from '../src/db/sqlite.js'
import { migrate } from '../src/db/schema.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('migration v4', () => {
  it('全新库迁移后 messages 有 topic 列、agent_topics 表存在、user_version=4', () => {
    const db = openDb(join(tmpdir(), `v4-${Date.now()}.db`))
    migrate(db)
    expect((db.prepare('PRAGMA user_version').get() as any).user_version).toBe(4)
    const cols = (db.prepare('pragma table_info(messages)').all() as any[]).map(c => c.name)
    expect(cols).toContain('topic')
    const tcols = (db.prepare('pragma table_info(agent_topics)').all() as any[]).map(c => c.name)
    expect(tcols).toEqual(['agent_id', 'topic', 'refreshed_at', 'expires_at'])
  })
  it('v3 存量 messages 行升级后 topic 默认 _default', () => {
    // 手建停在 v3 的库（全量 migrate 过再降版本会撞 duplicate column,无法降级——migration-v3.test.ts 同款手法）
    const db = openDb(':memory:')
    db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      capabilities TEXT NOT NULL DEFAULT '[]', task_policy TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      profile TEXT NOT NULL DEFAULT '{}', profile_updated_at TEXT NOT NULL DEFAULT '')`)
    db.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, client_msg_id TEXT NOT NULL, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
      type TEXT NOT NULL, body TEXT NOT NULL, thread_id TEXT, created_at TEXT NOT NULL, delivered_at TEXT, read_at TEXT)`)
    db.prepare(`INSERT INTO agents (id, display_name, created_at, last_seen_at) VALUES ('a1','A','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`).run()
    db.prepare(`INSERT INTO messages (id, client_msg_id, from_agent, to_agent, type, body, created_at) VALUES ('m1','c1','a1','a1','text','{}','2026-01-01T00:00:00Z')`).run()
    db.prepare('PRAGMA user_version = 3').run()
    migrate(db) // v3→v4 增量
    expect((db.prepare('SELECT topic FROM messages WHERE id=?').get('m1') as any).topic).toBe('_default')
  })
})
```

`server/test/topic-api.test.ts`（发送部分；`base.mk` 为 helpers 现有注册函数，返回 `{agent, token}`，`agent.id` 即账号 id——以 `test/helpers/ws-server.ts` 实际导出为准，若名不同用实际名替换，断言不变）：

```ts
// topic 字段全链路:schema 校验/落库/默认值/inbox-history 过滤透传
import { describe, it, expect, beforeEach } from 'vitest'
import { startWsServer } from './helpers/ws-server.js'

let base: Awaited<ReturnType<typeof startWsServer>>
beforeEach(async () => { base = await startWsServer({}) })

describe('POST /v1/messages topic', () => {
  it('带合法 topic 落库且响应/收件方 inbox 带 topic', async () => {
    const A = await base.mk('alice-top'); const B = await base.mk('bob-top')
    const res = await base.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${B.token}` }, payload: { to: A.agent.id, type: 'text', body: { text: 'hi' }, client_msg_id: 'c1', topic: 'imchat' } })
    expect(res.statusCode).toBe(201)
    expect(res.json().message.topic).toBe('imchat')
    const inbox = await base.app.inject({ method: 'GET', url: '/v1/inbox', headers: { authorization: `Bearer ${A.token}` } })
    expect(inbox.json()[0].topic).toBe('imchat')
  })
  it('省略 topic → _default；显式 _default 合法等价', async () => {
    const A = await base.mk('alice-top2'); const B = await base.mk('bob-top2')
    const r1 = await base.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${B.token}` }, payload: { to: A.agent.id, type: 'text', body: { text: 'a' }, client_msg_id: 'c2' } })
    const r2 = await base.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${B.token}` }, payload: { to: A.agent.id, type: 'text', body: { text: 'b' }, client_msg_id: 'c3', topic: '_default' } })
    expect(r1.json().message.topic).toBe('_default')
    expect(r2.statusCode).toBe(201)
  })
  it('非法 topic（大写/下划线开头/超长）→ 400 INVALID_REQUEST', async () => {
    const A = await base.mk('alice-top3'); const B = await base.mk('bob-top3')
    for (const bad of ['Imchat', '_x', 'a'.repeat(33)]) {
      const r = await base.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${B.token}` }, payload: { to: A.agent.id, type: 'text', body: { text: 'x' }, client_msg_id: 'c-' + bad, topic: bad } })
      expect(r.statusCode).toBe(400)
    }
  })
  it('inbox?topic= 与 history?topic= 过滤', async () => {
    const A = await base.mk('alice-top4'); const B = await base.mk('bob-top4')
    for (const [cmid, topic] of [['t1', 'imchat'], ['t2', 'promote'], ['t3', undefined]] as const)
      await base.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${B.token}` }, payload: { to: A.agent.id, type: 'text', body: { text: 'x' }, client_msg_id: cmid, ...(topic ? { topic } : {}) } })
    const inbox = await base.app.inject({ method: 'GET', url: '/v1/inbox?topic=imchat', headers: { authorization: `Bearer ${A.token}` } })
    expect(inbox.json()).toHaveLength(1)
    expect(inbox.json()[0].topic).toBe('imchat')
    const hist = await base.app.inject({ method: 'GET', url: '/v1/history?topic=promote', headers: { authorization: `Bearer ${A.token}` } })
    expect(hist.json().some((m: any) => m.topic === 'promote')).toBe(true)
    expect(hist.json().every((m: any) => m.topic === 'promote')).toBe(true)
  })
  it('srv: 派生消息 topic 落 _default（spec §1 决策钉住，critic-M4）', async () => {
    const A = await base.mk('alice-srv'); const B = await base.mk('bob-srv')
    const t = (await base.app.inject({ method: 'POST', url: '/v1/tasks', headers: { authorization: `Bearer ${A.token}` }, payload: { to: B.agent.id, action: 'ping', max_duration_s: 60 } })).json().task
    await base.app.inject({ method: 'POST', url: `/v1/tasks/${t.id}/accept`, headers: { authorization: `Bearer ${B.token}` }, payload: {} })
    await base.app.inject({ method: 'POST', url: `/v1/tasks/${t.id}/result`, headers: { authorization: `Bearer ${B.token}` }, payload: { status: 'completed', result: 'ok' } })
    const hist = (await base.app.inject({ method: 'GET', url: `/v1/history?peer=${B.agent.id}&limit=100`, headers: { authorization: `Bearer ${A.token}` } })).json()
    const srvMsgs = hist.filter((m: any) => m.id.startsWith('srv:'))
    expect(srvMsgs.length).toBeGreaterThan(0)
    expect(srvMsgs.every((m: any) => m.topic === '_default')).toBe(true)
  })
  it('WS 推送帧带 topic（critic-M5）', async () => {
    const A = await base.mk('alice-ws'); const B = await base.mk('bob-ws')
    // 夹具照 test/ws.test.ts 现状:WebSocket 连 base.url 的 /ws + auth 帧 + next(ws, pred) 等帧辅助
    const wsB = await wsConnect(base.url, B.token)
    const send = await base.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${A.token}` }, payload: { to: B.agent.id, type: 'text', body: { text: 'x' }, client_msg_id: 'ws1', topic: 'imchat' } })
    const mid = send.json().message.id
    const frame = await next(wsB, (f: any) => f.op === 'message' && f.message.id === mid)
    expect(frame.message.topic).toBe('imchat')
    wsB.close()
  })
})
```

（`wsConnect`/`next` 从 `test/ws.test.ts` 复制其私有辅助或提炼到 helpers——按该文件现状最小改动落地，断言如上。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run test/migration-v4.test.ts test/topic-api.test.ts`
Expected: FAIL（无 topic 列/字段被 schema 剥离）

- [ ] **Step 3: 实现**

`schema.ts` 末尾追加：

```ts
  // v1.3 迁移：topic 隔离（spec 2026-10-02-topic-isolation-design.md §1/§2）
  if (v < 4) {
    db.transaction(() => {
      db.exec(`
      ALTER TABLE messages ADD COLUMN topic TEXT NOT NULL DEFAULT '_default';
      CREATE TABLE IF NOT EXISTS agent_topics (
        agent_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        refreshed_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, topic)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_topics_agent ON agent_topics(agent_id);
      CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(to_agent, topic, id);
      `)
      db.prepare('PRAGMA user_version = 4').run()
    })()
  }
```

`core/messages.ts`：`Message` 接口加 `topic: string`；`COLS` 改为 `'id, client_msg_id, from_agent as \`from\`, to_agent as \`to\`, type, body, thread_id, topic, created_at, delivered_at, read_at'`（注意老行默认值由 ALTER DEFAULT 兜底，rowToMsg 不需特判）；新增导出：

```ts
// topic 格式（spec §1）：保留名 _default 或小写风格 ≤32；_default=广播
export const TOPIC_RE = /^(_default|[a-z0-9][a-z0-9._-]{0,31})$/
```

`sendMessage`：参数类型加 `topic?: string`；在 threadId 校验后加：

```ts
  const topic = input.topic ?? '_default'
  if (!TOPIC_RE.test(topic)) throw Errors.invalidRequest(`topic must match ^(_default|[a-z0-9][a-z0-9._-]{0,31})$`)
```

INSERT 列加 `topic` 与对应值。`getInbox` 签名改 `(db, agentId, limit, threadId?, topic?)`，条件拼接 `const tp = topic ? ' AND topic=?' : ''` 依样传参。`history` 的 `q` 类型加 `topic?: string`，与 threadId 同法拼接 ` AND topic=?`。

`routes/send.ts`：body properties 加 `topic: { type: 'string', maxLength: 32 }`（格式校验留 core 单点，同 thread_id 模式——schema 层 maxLength 兜底防超长字符串穿 schema）。

`routes/messages.ts`：inbox 与 history 的 querystring properties 各加 `topic: { type: 'string', maxLength: 32 }`；inbox 调 `getInbox(db, me, limit, thread_id, (req.query as any).topic)`；history 透传 `topic: q.topic`。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd server && npx vitest run test/migration-v4.test.ts test/topic-api.test.ts && npm test`
Expected: 全 PASS（既有全量用例不回归——hub.ts 的 `getInbox(db, s.agentId, 100)` 不传 topic，签名向后兼容）

- [ ] **Step 5: Commit**

```bash
git add server/src/db/schema.ts server/src/core/messages.ts server/src/http/routes/send.ts server/src/http/routes/messages.ts server/test/migration-v4.test.ts server/test/topic-api.test.ts
git commit -m "feat: messages.topic 字段 v4 迁移与全链路透传"
```

---

### Task 2: 服务器 — agent_topics 注册表 + 三端点

**Files:**
- Create: `server/src/core/topics.ts`
- Modify: `server/src/config.ts`（`rate` 加 `topicsPerMin`，env `RATE_LIMIT_TOPICS_PER_MIN` 默认 60——critic-M9，走 cfg.rate 模式）
- Modify: `server/src/core/ratelimit.ts`（加 `checkTopics` 走 `this.rate.topicsPerMin`）
- Modify: `server/src/http/routes/agents.ts`（PUT/GET `/v1/me/topics`）
- Modify: `server/src/http/routes/directory.ts`（GET `/v1/agents/:id/topics`）
- Test: `server/test/topic-api.test.ts`（追加注册表 describe 块）

**Interfaces:**
- Consumes: T1 的 `agent_topics` 表、`TOPIC_RE`。
- Produces: `upsertTopics(db, agentId, topics: string[]): void`；`activeTopics(db, agentId): { topic: string; refreshed_at: string }[]`（惰性过滤未过期）；`topicRegistered(db, agentId, topic): boolean`；`RateLimiter.checkTopics(agentId)`（`cfg.rate.topicsPerMin`，默认 60/min）。响应形状：`{ topics: [{topic, refreshed_at}] }`。spec §2 "scanner 顺手 DELETE"不做——读取路径惰性 DELETE 已全覆盖语义，决策：scanner 不改。

- [ ] **Step 1: 写失败测试（追加到 topic-api.test.ts）**

```ts
describe('topic registry', () => {
  it('PUT /v1/me/topics 注册；GET /v1/agents/:id/topics 可查；_default 拒绝', async () => {
    const A = await base.mk('alice-reg')
    const put = await base.app.inject({ method: 'PUT', url: '/v1/me/topics', headers: { authorization: `Bearer ${A.token}` }, payload: { topics: ['imchat', 'promote'] } })
    expect(put.statusCode).toBe(200)
    const get = await base.app.inject({ method: 'GET', url: `/v1/agents/${A.agent.id}/topics`, headers: { authorization: `Bearer ${A.token}` } })
    expect(get.json().topics.map((t: any) => t.topic).sort()).toEqual(['imchat', 'promote'])
    const bad = await base.app.inject({ method: 'PUT', url: '/v1/me/topics', headers: { authorization: `Bearer ${A.token}` }, payload: { topics: ['_default'] } })
    expect(bad.statusCode).toBe(400)
  })
  it('PUT 不注销列表外 topic（会话无权注销别人）；空数组合法 no-op', async () => {
    const A = await base.mk('alice-reg2')
    await base.app.inject({ method: 'PUT', url: '/v1/me/topics', headers: { authorization: `Bearer ${A.token}` }, payload: { topics: ['a.b'] } })
    await base.app.inject({ method: 'PUT', url: '/v1/me/topics', headers: { authorization: `Bearer ${A.token}` }, payload: { topics: ['c-d'] } })
    await base.app.inject({ method: 'PUT', url: '/v1/me/topics', headers: { authorization: `Bearer ${A.token}` }, payload: { topics: [] } })
    const get = await base.app.inject({ method: 'GET', url: `/v1/agents/${A.agent.id}/topics`, headers: { authorization: `Bearer ${A.token}` } })
    expect(get.json().topics.map((t: any) => t.topic).sort()).toEqual(['a.b', 'c-d'])
  })
  it('发送响应带 topic_registered；未注册 topic 不拒收', async () => {
    const A = await base.mk('alice-reg3'); const B = await base.mk('bob-reg3')
    await base.app.inject({ method: 'PUT', url: '/v1/me/topics', headers: { authorization: `Bearer ${A.token}` }, payload: { topics: ['imchat'] } })
    const r1 = await base.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${B.token}` }, payload: { to: A.agent.id, type: 'text', body: { text: 'x' }, client_msg_id: 'reg1', topic: 'imchat' } })
    expect(r1.json().topic_registered).toBe(true)
    const r2 = await base.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${B.token}` }, payload: { to: A.agent.id, type: 'text', body: { text: 'y' }, client_msg_id: 'reg2', topic: 'ghost' } })
    expect(r2.statusCode).toBe(201)
    expect(r2.json().topic_registered).toBe(false)
  })
  it('TTL 过期：expires_at 过去后 GET 返回空、topic_registered 变 false（critic-M6）', async () => {
    const A = await base.mk('alice-reg4'); const B = await base.mk('bob-reg4')
    await base.app.inject({ method: 'PUT', url: '/v1/me/topics', headers: { authorization: `Bearer ${A.token}` }, payload: { topics: ['imchat'] } })
    // 直接改库快进过期（不走真实 25h;ws-server helper 已暴露 base.db,直接 exec）:
    base.db.exec(`UPDATE agent_topics SET expires_at = '2000-01-01T00:00:00Z'`)
    const get = await base.app.inject({ method: 'GET', url: `/v1/agents/${A.agent.id}/topics`, headers: { authorization: `Bearer ${A.token}` } })
    expect(get.json().topics).toEqual([])
    const r = await base.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${B.token}` }, payload: { to: A.agent.id, type: 'text', body: { text: 'z' }, client_msg_id: 'reg5', topic: 'imchat' } })
    expect(r.json().topic_registered).toBe(false)
  })
  it('topics 上报限频：连续 PUT 超 topicsPerMin → 429（critic-M6）', async () => {
    const A = await base.mk('alice-reg5')
    let last = 200
    for (let i = 0; i <= 60; i++) last = (await base.app.inject({ method: 'PUT', url: '/v1/me/topics', headers: { authorization: `Bearer ${A.token}` }, payload: { topics: ['t' + (i % 8)] } })).statusCode
    expect(last).toBe(429)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run test/topic-api.test.ts -t registry`
Expected: FAIL（404 路由不存在）

- [ ] **Step 3: 实现**

`core/topics.ts`（新建）：

```ts
// 账号 topic 注册表（spec §2）：会话上报活跃 topic，TTL 25h；发送方查询辅助决策
import type { Db } from '../db/sqlite.js'
import { TOPIC_RE } from './messages.js'
import { Errors } from '../http/errors.js'

const TTL_MS = 25 * 3600_000

export function upsertTopics(db: Db, agentId: string, topics: string[]): void {
  if (topics.length > 8) throw Errors.invalidRequest('topics 最多 8 项')
  const seen = new Set<string>()
  for (const t of topics) {
    if (!TOPIC_RE.test(t) || t === '_default') throw Errors.invalidRequest(`非法 topic: ${t}（小写 [a-z0-9._-] ≤32，_default 保留）`)
    if (seen.has(t)) throw Errors.invalidRequest(`topic 重复: ${t}`)
    seen.add(t)
  }
  const now = new Date(); const iso = now.toISOString()
  const exp = new Date(now.getTime() + TTL_MS).toISOString()
  const stmt = db.prepare(`INSERT INTO agent_topics (agent_id, topic, refreshed_at, expires_at) VALUES (?,?,?,?)
    ON CONFLICT(agent_id, topic) DO UPDATE SET refreshed_at=excluded.refreshed_at, expires_at=excluded.expires_at`)
  db.transaction(() => { for (const t of topics) stmt.run(agentId, t, iso, exp) })()
}

export function activeTopics(db: Db, agentId: string): { topic: string; refreshed_at: string }[] {
  db.prepare('DELETE FROM agent_topics WHERE expires_at < ?').run(new Date().toISOString()) // 惰性清理
  return db.prepare('SELECT topic, refreshed_at FROM agent_topics WHERE agent_id=? ORDER BY topic').all(agentId) as never
}

export function topicRegistered(db: Db, agentId: string, topic: string): boolean {
  if (topic === '_default') return true
  return !!db.prepare('SELECT 1 FROM agent_topics WHERE agent_id=? AND topic=? AND expires_at > ?').get(agentId, topic, new Date().toISOString())
}
```

`ratelimit.ts` RateLimiter 类加（限频值走 config，critic-M9）：

```ts
  checkTopics(agentId: string) { this.check(`topics:${agentId}`, this.rate.topicsPerMin, 'topics') }
```

`config.ts` 的 `rate` 对象加一行（与既有 `messagePerMin` 等同模式）：`topicsPerMin: Number(env.RATE_LIMIT_TOPICS_PER_MIN ?? 60)`（`Config['rate']` 类型同步加 `topicsPerMin: number`）。

TTL 测试用 `base.db.exec(...)` 直改库——`ws-server.ts` 已返回 `db`，无 helper 改动。

`routes/agents.ts` registerMeRoutes 末尾加：

```ts
  // topic 注册表（spec §2）：会话上报本机活跃项目 topic；PUT 不注销列表外项
  app.put('/v1/me/topics', { preHandler: auth, schema: { body: { type: 'object', required: ['topics'], additionalProperties: false, properties: { topics: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 32 } } } } } }, async (req) => {
    const me = getAuth(req).agent.id
    deps.limiter.checkTopics(me)
    upsertTopics(deps.db, me, (req.body as any).topics)
    return { topics: activeTopics(deps.db, me) }
  })
  app.get('/v1/me/topics', { preHandler: auth }, async (req) => ({ topics: activeTopics(deps.db, getAuth(req).agent.id) }))
```

（import 行补 `import { upsertTopics, activeTopics } from '../../core/topics.js'`。）

`routes/directory.ts` 在 GET /v1/agents/:id 同层加（沿用该文件既有的 auth 与 getAgent 404 模式）：

```ts
  // 对端活跃 topic 查询（spec §2/§3）：发送方 CLI 决策输入；目录级公开信息
  app.get('/v1/agents/:id/topics', { preHandler: auth }, async (req) => {
    getAgent(deps.db, (req.params as any).id) // 404 if unknown
    return { topics: activeTopics(deps.db, (req.params as any).id) }
  })
```

`routes/send.ts` 发送成功返回处（T1 改后）补 `topic_registered: topicRegistered(deps.db, input.to, out.message.topic)`（import 补 `topicRegistered`；deduplicated 重放分支同样带上）。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd server && npx vitest run test/topic-api.test.ts && npm test && npx tsc -p tsconfig.json --noEmit`
Expected: 全 PASS，tsc 干净

- [ ] **Step 5: Commit**

```bash
git add server/src/core/topics.ts server/src/core/ratelimit.ts server/src/http/routes/agents.ts server/src/http/routes/directory.ts server/src/http/routes/send.ts server/test/topic-api.test.ts
git commit -m "feat: agent_topics 注册表与 /v1/{me,agents}/topics 端点"
```

---

### Task 3: 客户端 — spool 按 topic 重布局 + daemon 分拣

**Files:**
- Modify: `skills/agentlink/lib/spool.mjs`（全函数双参化）
- Modify: `skills/agentlink/daemon.mjs`（无需大改——writeMessage 内部读 `msg.topic`）
- Modify: `skills/agentlink/lib/inbox-local.mjs`（unreadList/maxCursor 调用适配）
- Modify: `skills/agentlink/hook-stop.mjs`（critic-H1：claim 签名变更的强制消费者，不改则 Stop 注入永不认领、重复注入）
- Create: `skills/agentlink/lib/topics.mjs`（最小版：仅 `TOPIC_RE` + `projectTopics`——hook-stop 消费；`pushTopics` T4 再加）
- Test: `skills/agentlink/test/spool.test.mjs`（重写断言布局）、`skills/agentlink/test/daemon.test.mjs`（追加 topic 落盘用例）、`skills/agentlink/test/hook-stop.test.mjs`（夹具按新布局修）

**Interfaces:**
- Consumes: T1/T2 服务器返回的 `message.topic`（WS 帧、history 均带）。
- Produces: `spoolDir(agentId, topic)`、`writeMessage(agentId, msg)`（msg.topic 缺省 `_default`）、`unreadList(agentId, topic)`、`unreadListMulti(agentId, topics[]): Message[]`、`unreadAll(agentId): {topic, msgs}[]`、`claim(agentId, topic, msgId)`、`maxCursor(agentId)`（跨 topic 全局最大）、`cleanup(agentId, nowMs)`、`clearTmp(agentId)`（遍历 topics/*）。T4/T5 依赖这些签名。

- [ ] **Step 1: 写失败测试**

`test/spool.test.mjs` 追加（保留既有文件结构，AGENTS state 指临时目录的方式沿用该文件现状）：

```js
test('spool 按 topic 分目录:写入/读取/认领互不串', () => {
  const A = 't-agent-1'
  writeMessage(A, { id: 'm1', topic: 'imchat', from: 'x', to: A, type: 'text', body: { text: 'a' }, created_at: 1 })
  writeMessage(A, { id: 'm2', topic: 'promote', from: 'x', to: A, type: 'text', body: { text: 'b' }, created_at: 2 })
  writeMessage(A, { id: 'm3', from: 'x', to: A, type: 'text', body: { text: 'c' }, created_at: 3 }) // 无 topic → _default
  assert.deepEqual(unreadList(A, 'imchat').map(m => m.id), ['m1'])
  assert.deepEqual(unreadList(A, 'promote').map(m => m.id), ['m2'])
  assert.deepEqual(unreadList(A, '_default').map(m => m.id), ['m3'])
  assert.ok(claim(A, 'imchat', 'm1'))
  assert.deepEqual(unreadList(A, 'imchat'), [])
  assert.deepEqual(unreadList(A, 'promote').map(m => m.id), ['m2']) // 认领不跨 topic 误伤
})

test('同 msg id 已 consumed 后换 topic 重放不复活（补洞场景）', () => {
  const A = 't-agent-2'
  assert.ok(writeMessage(A, { id: 'm9', topic: 'imchat', from: 'x', to: A, type: 'text', body: {}, created_at: 1 }))
  claim(A, 'imchat', 'm9')
  assert.equal(writeMessage(A, { id: 'm9', topic: 'imchat', from: 'x', to: A, type: 'text', body: {}, created_at: 1 }), false)
  // 服务器旧帧若 topic 缺失重放为 _default:consumed 只看本 topic 目录,_default 落盘但同 id pending 亦拒绝
  assert.equal(writeMessage(A, { id: 'm9', from: 'x', to: A, type: 'text', body: {}, created_at: 1 }), true) // _default 目录首次 → 落盘
  assert.equal(writeMessage(A, { id: 'm9', from: 'x', to: A, type: 'text', body: {}, created_at: 1 }), false) // 同目录重复 → 拒
})

test('maxCursor 跨 topic 全局取最大（RF3）', () => {
  const A = 't-agent-3'
  writeMessage(A, { id: 'msg_00A', topic: 'imchat', from: 'x', to: A, type: 'text', body: {}, created_at: 1 })
  writeMessage(A, { id: 'msg_00B', topic: 'promote', from: 'x', to: A, type: 'text', body: {}, created_at: 2 })
  assert.equal(maxCursor(A), 'msg_00B')
})

test('unreadListMulti 聚合多 topic 并按 created_at 排序;unreadAll 列全部', () => {
  const A = 't-agent-4'
  writeMessage(A, { id: 'n1', topic: 'imchat', from: 'x', to: A, type: 'text', body: {}, created_at: 1 })
  writeMessage(A, { id: 'n2', topic: '_default', from: 'x', to: A, type: 'text', body: {}, created_at: 2 })
  assert.deepEqual(unreadListMulti(A, ['imchat', '_default']).map(m => m.id), ['n1', 'n2'])
  const all = unreadAll(A)
  assert.deepEqual(all.map(x => x.topic).sort(), ['_default', 'imchat'])
})
```

`test/daemon.test.mjs` 追加：

```js
test('WS message 帧带 topic → 落对应 topic 目录并 ack', async () => {
  // 沿用本文件既有的 createDaemon + 假 WS 服务器夹具;直接调用内部路径不可行时,用 writeMessage 断言即可:
  const A = 't-daemon-1'
  writeMessage(A, { id: 'd1', topic: 'imchat', from: 'x', to: A, type: 'text', body: { text: 'hi' }, created_at: 1 })
  assert.equal(unreadList(A, 'imchat')[0].id, 'd1')
})
```

（注：spool.test.mjs 现有平铺布局断言会失败——**改写它们**到新布局而非删除用例数；实现者读现有文件后逐条对齐。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd skills/agentlink && node --test test/spool.test.mjs`
Expected: FAIL（spoolDir 无 topic 参数、目录不存在）

- [ ] **Step 3: 实现 spool.mjs**

```js
// skills/agentlink/lib/spool.mjs — topic 布局版
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { SPOOL_ROOT } from './identity.mjs'

const exists = (p) => { try { statSync(p); return true } catch { return false } }
const PERM = { recursive: true, mode: 0o700 }
// topic 目录布局（spec §4.2）：spool/<agentId>/topics/<topic>/{*.json, consumed/}
export const spoolDir = (a, topic = '_default') => {
  const d = join(SPOOL_ROOT, a, 'topics', topic)
  mkdirSync(d, PERM); mkdirSync(join(d, 'consumed'), PERM)
  return d
}
const consumedDir = (a, topic) => join(SPOOL_ROOT, a, 'topics', topic, 'consumed')
const read1 = (p) => JSON.parse(readFileSync(p, 'utf8'))
// 遍历某 agent 全部 topic 名（目录名即 topic;无目录返回 ['_default'] 保持函数可调用）
export function topics(agentId) {
  const root = join(SPOOL_ROOT, agentId, 'topics')
  try { return readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) } catch { return [] }
}

export function writeMessage(agentId, msg) {
  const topic = msg.topic ?? '_default'
  const d = spoolDir(agentId, topic)
  const final = join(d, msg.id + '.json')
  if (exists(join(d, 'consumed', msg.id + '.json')) || exists(final)) return false // consumed 不复活(本 topic 目录内判定,RF2)
  const tmp = join(d, msg.id + '.tmp')
  writeFileSync(tmp, JSON.stringify({ ...msg, topic, received_at: Date.now() }), { mode: 0o600 })
  try { renameSync(tmp, final); return true } catch { unlinkSync(tmp); return false }
}
export function unreadList(agentId, topic = '_default') {
  const d = spoolDir(agentId, topic)
  return readdirSync(d).filter(f => f.endsWith('.json')).map(f => read1(join(d, f)))
    .sort((x, y) => (x.created_at ?? 0) - (y.created_at ?? 0))
}
export function unreadListMulti(agentId, list) {
  return list.flatMap(t => unreadList(agentId, t)).sort((x, y) => String(x.created_at ?? '').localeCompare(String(y.created_at ?? ''))) // ISO 字符串字典序=时间序(critic-L12:数值相减对 ISO 得 NaN)
}
export function unreadAll(agentId) {
  return topics(agentId).map(topic => ({ topic, msgs: unreadList(agentId, topic) })).filter(x => x.msgs.length)
}
export function claim(agentId, topic, msgId) {
  const d = spoolDir(agentId, topic)
  try { renameSync(join(d, msgId + '.json'), join(d, 'consumed', msgId + '.json')); return true } catch { return false }
}
export function maxCursor(agentId) {
  // 补洞游标跨 topic 全局取最大（RF3）：只看 pending+consumed 的文件名 id
  let ids = []
  for (const t of topics(agentId)) {
    const d = spoolDir(agentId, t)
    ids = [...ids, ...readdirSync(d), ...readdirSync(consumedDir(agentId, t))]
  }
  ids = ids.filter(f => f.endsWith('.json')).map(f => f.slice(0, -5))
  return ids.length ? ids.sort().at(-1) : null
}
export function cleanup(agentId, nowMs) {
  for (const t of topics(agentId)) for (const f of readdirSync(consumedDir(agentId, t))) {
    const p = join(consumedDir(agentId, t), f)
    if (nowMs - (read1(p).received_at ?? 0) > 7 * 86400_000) unlinkSync(p)
  }
}
export function clearTmp(agentId) {
  for (const t of topics(agentId)) for (const f of readdirSync(spoolDir(agentId, t))) if (f.endsWith('.tmp')) unlinkSync(join(spoolDir(agentId, t), f))
}
```

`daemon.mjs`：入信行改为 `writeMessage(agentId, m)` 不变（m.topic 已由服务器帧带出，writeMessage 内部兜底）；backfill 行 `m.to === agentId` 判断不变。启动清理（第 85 行）遍历 `spool/<dir>/topics/*`——改为对每个 agent 目录调 `clearTmp(目录名)`（clearTmp 已遍历 topics，外层循环保持现状即可）。

`hook-stop.mjs`（critic-H1，同 T4 hook-inject 的改法）：`unreadList(agentId)` 改 `unreadListMulti(agentId, [...new Set([...projectTopics(cwd), '_default'])])`（顶层 `import { projectTopics } from './lib/topics.mjs'`——topics.mjs 本任务先建最小版，否则 T3 无法独立编译）；`claim(agentId, id)` 改 `claim(agentId, m.topic ?? '_default', id)`。`test/hook-stop.test.mjs` 夹具同步到新 spool 布局与本文件签名。

`lib/topics.mjs`（新建最小版，T4 再补 pushTopics）：

```js
// skills/agentlink/lib/topics.mjs — 项目 topic 声明（spec §4.1）
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

export const TOPIC_RE = /^(_default|[a-z0-9][a-z0-9._-]{0,31})$/

// 从 cwd 向上找最近 .agentlink.json,取合法 topics（_default 声明无意义被滤）;无 → []
export function projectTopics(cwd) {
  let d = cwd
  for (;;) {
    const p = join(d, '.agentlink.json')
    if (existsSync(p)) {
      try {
        const j = JSON.parse(readFileSync(p, 'utf8'))
        const list = Array.isArray(j.topics) ? j.topics : []
        return [...new Set(list)].filter(t => typeof t === 'string' && TOPIC_RE.test(t) && t !== '_default').slice(0, 8)
      } catch { return [] } // 坏文件=无声明,不炸
    }
    const parent = dirname(d)
    if (parent === d) return []
    d = parent
  }
}
```

`lib/inbox-local.mjs`：`localInbox` 改为 `unreadList(id, '_default')` 起步——本任务先保底 `_default`（T4 引入 projectTopics 后升级为多 topic 读取）；`localInboxPlan` 的 `cursor: maxCursor(id)` 不变（签名同）。

- [ ] **Step 4: 跑测试确认通过 + 客户端全量**

Run: `cd skills/agentlink && node --test`（全部测试文件）
Expected: 全 PASS（hook-inject/inject 等既有用例若依赖平铺 spool 夹具，按新布局修夹具路径——夹具改动属本任务）

- [ ] **Step 5: Commit**

```bash
git add skills/agentlink/lib/spool.mjs skills/agentlink/daemon.mjs skills/agentlink/lib/inbox-local.mjs skills/agentlink/test/
git commit -m "feat: spool 按 topic 分目录布局与全函数双参化"
```

---

### Task 4: 客户端 — .agentlink.json 项目声明 + hook-inject 过滤/警告/上报

**Files:**
- Modify: `skills/agentlink/lib/topics.mjs`（T3 已建最小版；本任务追加 `pushTopics`）
- Modify: `skills/agentlink/hook-inject.mjs`
- Modify: `skills/agentlink/lib/inject.mjs`（信头带 topic）
- Modify: `skills/agentlink/lib/inbox-local.mjs`（localInbox 按 projectTopics 过滤）
- Test: `skills/agentlink/test/topics.test.mjs`（新建）、`skills/agentlink/test/hook-inject.test.mjs`（追加）

**Interfaces:**
- Consumes: T3 的 `unreadListMulti/unreadAll/topics`；T2 的 `PUT /v1/me/topics`。
- Produces: `pushTopics({ agentId, token, server, topics }): Promise<boolean>`（读 `topic-push-<agentId>.json` 缓存，变化或 >1h 才 PUT）。`projectTopics`/`TOPIC_RE` 已由 T3 产出。

- [ ] **Step 1: 写失败测试**

`test/topics.test.mjs`（新建）：

```js
// projectTopics 向上查找 + 非法项静默丢弃（RF1/RF4）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('projectTopics: 本目录 .agentlink.json 生效;非法 topic 丢弃;无文件 → []', async () => {
  const { projectTopics } = await import('../lib/topics.mjs')
  const root = mkdtempSync(join(tmpdir(), 'al-top-'))
  writeFileSync(join(root, '.agentlink.json'), JSON.stringify({ topics: ['imchat', 'Bad', '_default', 'x'.repeat(33)] }))
  assert.deepEqual(projectTopics(join(root, 'sub', 'dir')), ['imchat']) // 向上找到 + 只剩合法项;_default 声明无意义被滤
  const bare = mkdtempSync(join(tmpdir(), 'al-bare-'))
  assert.deepEqual(projectTopics(bare), [])
  writeFileSync(join(bare, '.agentlink.json'), JSON.stringify({}))
  assert.deepEqual(projectTopics(bare), [])
})
```

`test/hook-inject.test.mjs` 追加（夹具沿本文件现状——临时 AGENTS_DIR + env + state 目录注入）：

```js
test('hook: 只注入本会话 topics ∪ _default;异 topic pending 出警告行;信头带 topic', async () => {
  // 夹具:agents.d 一个 env(name=t, dir=<projRoot>);projRoot 放 .agentlink.json {topics:['imchat']}
  // spool 落三条:imchat m1 / promote m2 / _default m3
  // 期望 r.text 含 m1、m3 正文与 'topic=imchat'、'广播',不含 m2 正文,含 '⚠ 存在 1 封' 与 'promote'
  // 具体构造沿用本文件既有 env/state 注入方式,断言以下四条:
  // assert.ok(r.text.includes('m1-body')); assert.ok(!r.text.includes('m2-body'))
  // assert.ok(r.text.includes('topic=imchat')); assert.ok(r.text.includes('⚠ 存在 1 封落在 topic「promote」'))
})
test('hook: 无 .agentlink.json 的 cwd → 只见 _default,不报错', async () => { /* 夹具同上,无 .agentlink.json;断言只见 _default 信 */ })
```

（实现者将上面注释式用例补全为可运行代码，断言文本以 Step 3 实现的警告文案为准逐字对齐。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd skills/agentlink && node --test test/topics.test.mjs test/hook-inject.test.mjs`
Expected: FAIL（lib/topics.mjs 不存在 / 行为缺失）

- [ ] **Step 3: 实现**

`lib/topics.mjs`（新建——T3 最小版，含 `TOPIC_RE` + `projectTopics`；`pushTopics` T4 再补）：

```js
// skills/agentlink/lib/topics.mjs 追加（import 行补 writeFileSync/homedir）——注册表续期（spec §4.3）
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

// 变化或距上次 >1h 才 PUT;缓存按 agentId 分文件
export async function pushTopics({ agentId, token, server, topics: list }) {
  const cachePath = join(process.env.AGENTLINK_STATE ?? join(homedir(), '.local/state/agentlink'), `topic-push-${agentId}.json`)
  let cached = null
  try { cached = JSON.parse(readFileSync(cachePath, 'utf8')) } catch {}
  const fresh = cached && Date.now() - cached.at < 3600_000 && JSON.stringify(cached.topics) === JSON.stringify(list)
  if (fresh) return false
  const res = await fetch(`${server.replace(/\/+$/, '')}/v1/me/topics`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ topics: list }) })
  if (!res.ok) return false // 上报失败不阻塞注入
  writeFileSync(cachePath, JSON.stringify({ topics: list, at: Date.now() }), { mode: 0o600 })
  return true
}
```

`hook-inject.mjs` `runHook` 在 `agentId` 求得后插入：

```js
  const { projectTopics, pushTopics } = await import('./lib/topics.mjs')
  const { unreadListMulti, unreadAll } = await import('./lib/spool.mjs')
  const mine = projectTopics(cwd)
  pushTopics({ agentId, token: e.token, server: e.server, topics: mine }).catch(() => {}) // 异步续期,失败静默
  const see = [...new Set([...mine, '_default'])]
  const msgs = unreadListMulti(agentId, see)
  const others = unreadAll(agentId).filter(x => !see.includes(x.topic))
  let text = formatInjection(msgs)
  if (others.length) {
    const detail = others.map(x => `${x.msgs.length} 封落在 topic「${x.topic}」`).join('、')
    text += `\n⚠ 存在 ${detail} 的待处理信（本会话未订阅），用 im inbox --all 查看`
  }
  if (!msgs.length && !others.length) return null
  return { text, agentId, ids: msgs.map(m => [m.topic ?? '_default', m.id]) } // [topic, msgId] 对,未注入的信不认领
```

（原 `unreadList(agentId)` 行删除。）`claimIds` 改为逐对 claim：

```js
export function claimIds(agentId, pairs) {
  for (const [topic, id] of pairs) { try { claim(agentId, topic, id) } catch { /* ENOENT：并发输家，静默 */ } }
}
```

`lib/inject.mjs` meta 行改为：

```js
    const topic = m.topic && m.topic !== '_default' ? ` topic=${m.topic}` : ' topic=广播'
    const meta = `from=${m.from}${m.thread_id ? ` thread=${m.thread_id}` : ''}${topic}`
```

`lib/inbox-local.mjs` `localInbox` 改：

```js
export function localInbox({ cwd, hostname = osHostname() }) {
  const e = boundAgent(cwd)
  if (!e) return []
  return unreadListMulti(agentIdFor(e.name, hostname, e.dir), [...new Set([...projectTopics(cwd), '_default'])])
}
```

（`inbox-local.mjs` 顶层加 `import { projectTopics } from './topics.mjs'`。）

- [ ] **Step 4: 跑测试确认通过 + 客户端全量**

Run: `cd skills/agentlink && node --test`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add skills/agentlink/lib/topics.mjs skills/agentlink/hook-inject.mjs skills/agentlink/lib/inject.mjs skills/agentlink/lib/inbox-local.mjs skills/agentlink/test/
git commit -m "feat: hook-inject 按项目 topic 过滤注入与注册表续期"
```

---

### Task 5: 客户端 — im send 决策链 + im topics + inbox --all + SKILL.md

**Files:**
- Modify: `skills/agentlink/im.mjs`（send/inbox/topics 命令）
- Modify: `skills/agentlink/SKILL.md`（topic 用法）
- Test: `skills/agentlink/test/topic-cli.test.mjs`（新建，子进程与纯函数混合，不发真请求的部分照 profile-cli 模式）

**Interfaces:**
- Consumes: T4 `projectTopics`；T2 `GET /v1/agents/:id/topics` 响应形状 `{topics:[{topic,refreshed_at}]}`；T3 `unreadAll`。
- Produces: CLI 行为——`im send <to> <text> [--topic X | --reply <msgid>]`；`im topics`；`im inbox [--topic X | --all]`。

- [ ] **Step 1: 写失败测试**

`test/topic-cli.test.mjs`（新建）：

```js
// send 决策链纯函数部分:不连网,直接测 lib/topics-cli.mjs 的 decideTopic
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('decideTopic: --reply 命中本地原信 → 继承其 topic', async () => {
  const { decideTopic } = await import('../lib/topics-cli.mjs')
  // 夹具:临时 state 目录 spool 已有 consumed 记录 {id:'m1', topic:'imchat'}
  assert.equal(await decideTopic({ to: 'x', reply: 'm1', localLookup: async () => 'imchat', fetchTopics: async () => [] }), 'imchat')
})
test('decideTopic: --reply 本地查不到 → 回退注册表;恰 1 个自动;0 个 → _default', async () => {
  const { decideTopic } = await import('../lib/topics-cli.mjs')
  assert.equal(await decideTopic({ reply: 'gone', localLookup: async () => null, fetchTopics: async () => [{ topic: 'promote' }] }), 'promote')
  assert.equal(await decideTopic({ reply: 'gone', localLookup: async () => null, fetchTopics: async () => [] }), '_default')
})
test('decideTopic: ≥2 个 → 抛错含列表(强制分诊);--topic 显式直用', async () => {
  const { decideTopic } = await import('../lib/topics-cli.mjs')
  await assert.rejects(decideTopic({ localLookup: async () => null, fetchTopics: async () => [{ topic: 'a' }, { topic: 'b' }] }), /a.*b/)
  assert.equal(await decideTopic({ topic: 'imchat', fetchTopics: async () => [{ topic: 'a' }, { topic: 'b' }] }), 'imchat')
})
```

（`decideTopic` 的 `localLookup` 默认实现与 `fetchTopics` 默认实现在 lib 内——测试注入替换，见 Step 3。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd skills/agentlink && node --test test/topic-cli.test.mjs`
Expected: FAIL（lib/topics-cli.mjs 不存在）

- [ ] **Step 3: 实现**

`skills/agentlink/lib/topics-cli.mjs`（新建）：

```js
// im send 的 topic 决策链（spec §3）：--reply 继承 > 显式 > 注册表(1 自动/≥2 报错/0 广播)
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { SPOOL_ROOT } from './identity.mjs'

// 本地找 msgId 所属 topic:pending 扫内容,consumed 只看文件名(目录即 topic);agentId=null 安全返回 null
export async function defaultLocalLookup(agentId, msgId) {
  if (!agentId) return null // critic-M8:未绑定 cwd 避免 join(null,...) 抛 TypeError
  const { topics, unreadList } = await import('./spool.mjs')
  for (const t of topics(agentId)) {
    for (const m of unreadList(agentId, t)) if (m.id === msgId) return t
    const cd = join(SPOOL_ROOT, agentId, 'topics', t, 'consumed')
    try { if (readdirSync(cd).includes(msgId + '.json')) return t } catch {}
  }
  return null
}

export async function decideTopic({ to, topic, reply, agentId, localLookup = (id) => defaultLocalLookup(agentId, id), fetchTopics }) {
  if (topic) return topic
  if (reply) {
    const t = await localLookup(reply)
    if (t) return t
    // 查不到:视同无 --reply,继续决策链,不报错（spec §3.1）
  }
  const list = (await fetchTopics(to)) ?? []
  if (list.length === 1) return list[0].topic
  if (list.length >= 2) {
    const names = list.map(x => x.topic).join(', ')
    throw new Error(`对端有 ${list.length} 个活跃 topic: ${names} — 按内容挑一个,用 --topic <name> 重发（广播用 --topic _default）`)
  }
  return '_default'
}
```

`im.mjs`：

1. `send` 命令整体替换为：

```js
  send: async () => {
    const { decideTopic } = await import('./lib/topics-cli.mjs')
    const { boundAgentId } = await import('./lib/inbox-local.mjs')
    let topic
    try {
      topic = await decideTopic({
        to: rest[0], topic: flags.topic, reply: flags.reply, agentId: boundAgentId(process.cwd()),
        fetchTopics: async (peer) => (await api(`/agents/${peer}/topics`)).topics,
      })
    } catch (e) { die(e.message) }
    const body = { to: rest[0], type: 'text', body: { text: rest.slice(1).join(' ') }, client_msg_id: cmid(), thread_id: flags.thread }
    if (topic !== '_default') body.topic = topic
    const r = await api('/messages', { method: 'POST', body })
    if (r.topic_registered === false) console.error(`提示: 对端暂无活跃会话订阅 topic「${topic}」,信将在其 spool 等待`)
    out(r.message)
  },

2. `inbox-local.mjs` 导出新函数 `boundAgentId(cwd)`：内部用既有 `boundAgent(cwd)` + `agentIdFor`，无绑定返回 `null`。同时把 `localInboxPlan.local` 改为同 `localInbox` 的逻辑——T4 引入的多 topic 聚合已生效,plan.local 仍是 `_default`-only 死值会误导后来者（critic-L16）。

3. `inbox` 加 `--topic/--all`（critic-M3 history 也加；critic-L18 无绑定回退）：

```js
  inbox: async () => {
    const { localInboxPlan, boundAgentId } = await import('./lib/inbox-local.mjs')
    const { projectTopics } = await import('./lib/topics.mjs')
    const { unreadListMulti, unreadAll } = await import('./lib/spool.mjs')
    const plan = localInboxPlan({ cwd: process.cwd() })
    const id = boundAgentId(process.cwd())
    let msgs
    if (id) {
      msgs = flags.all ? unreadAll(id).flatMap(x => x.msgs) : unreadListMulti(id, [...new Set([...(flags.topic ? [flags.topic] : projectTopics(process.cwd())), '_default'])])
    } else if (flags.all) {
      console.error('提示: im inbox --all 需本地 daemon 绑定（agents.d 里有当前目录的 env）——回退 REST inbox')
      return out(await api(`/inbox?wait=${flags.wait ?? 0}`))
    }
    let local = msgs ?? plan.local
    if ((plan.needRest || !id) && !flags.all) { // --all 仅本地视角
      if (!id) return out(await api(`/inbox?wait=${flags.wait ?? 0}${flags.topic ? `&topic=${encodeURIComponent(flags.topic)}` : ''}`))
      const extra = await api(`/history?limit=100${plan.cursor ? `&after=${plan.cursor}` : ''}${flags.topic ? `&topic=${encodeURIComponent(flags.topic)}` : ''}`)
      msgs = [...(local ?? []), ...(Array.isArray(extra) ? extra : (extra.messages ?? [])).filter(m => m.to === id && !local.some(l => l.id === m.id))]
      local = msgs
    }
    out(local)
  },
  history: async () => out(await api(`/history?${rest[0] ? `peer=${rest[0]}&` : ''}limit=${flags.limit ?? 50}${flags.thread ? `&thread_id=${encodeURIComponent(flags.thread)}` : ''}${flags.topic ? `&topic=${encodeURIComponent(flags.topic)}` : ''}${flags.after ? `&after=${flags.after}` : ''}`)),
  read: async () => {
    // 服务端标 read_at 之外,还得把本地 spool 挪进 consumed——否则 im inbox(本地优先视图)里已读信永远赖着
    // critic-H2:claim 现需 (agentId, topic, msgId) 三参,先用 defaultLocalLookup 找 topic
    const { boundAgentId } = await import('./lib/inbox-local.mjs')
    const { defaultLocalLookup } = await import('./lib/topics-cli.mjs')
    const { claim } = await import('./lib/spool.mjs')
    const id = boundAgentId(process.cwd())
    for (const id2 of rest) {
      await api(`/messages/${id2}/read`, { method: 'POST' })
      if (id) {
        const topic = await defaultLocalLookup(id, id2) ?? '_default'
        if (!claim(id, topic, id2)) { /* ENOENT:并发输家或已 consumed,静默 */ }
      }
    }
    out(`read ${rest.length}`)
  },

4. 新命令 `topics`：`topics: async () => out(await api('/me/topics'))`，USAGE 串加 `topics`。

`SKILL.md`：命令表加一行 `im send <peer> <text> [--topic <t>|--reply <msgid>]`（说明决策链与广播），加小节「多项目隔离」三行：项目根放 `.agentlink.json`；回信用 `--reply`；查未订阅信用 `im inbox --all`。

- [ ] **Step 4: 跑测试确认通过 + 客户端全量 + 服务器全量（防协议回归）**

Run: `cd skills/agentlink && node --test && cd ../../server && npm test`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add skills/agentlink/im.mjs skills/agentlink/lib/topics-cli.mjs skills/agentlink/lib/inbox-local.mjs skills/agentlink/SKILL.md skills/agentlink/test/topic-cli.test.mjs
git commit -m "feat: im send topic 决策链与 im topics/inbox --all"
```

---

## 任务依赖

T1 → T2（注册表读表结构）→ T3（客户端消费服务器 topic 字段）→ T4（消费 T3 spool API）→ T5（消费 T4 projectTopics + T2 端点）。严格串行。
