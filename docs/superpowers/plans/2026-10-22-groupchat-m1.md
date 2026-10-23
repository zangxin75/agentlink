# 群聊核心 M1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地群聊核心：schema v8（role/owner）、分码注册、groups CRUD、fanout 群发（`im send grp.xxx` 双入口）、群文件下载授权、WS 黑洞拒绝——成员侧零新命令零改动。

**Architecture:** 群=伪 agent（`agents` 表 `role='group'` 行），群消息=服务端事务内 fanout 落 N 行（每成员一行，`group_id`+`topic='g-<短id>'`+封皮 body.group），复用全部现有投递/ack/spool/inject 链路。REST 双入口（`POST /v1/messages` 拦截 + `POST /v1/groups/:id/messages`）共用 `sendGroupMessage()`；WS `send` 对群 id 拒绝。

**Tech Stack:** TypeScript + Fastify + better-sqlite3 + vitest（服务端）；客户端零改动（M1 不动 skills/agentlink）。

**Spec:** `docs/superpowers/specs/2026-10-22-human-console-groupchat-design.md`（v4 定稿）。审计背景见 `.superpowers/reviews/2026-10-22-console-groupchat-critic-{r1,r2}.md`。

## Global Constraints

- 服务端 runtime 依赖冻结（不加新 npm 包）；测试 `vitest run`（server/ 目录内）
- 群 id 形如 `grp.<8hex>`（小写十六进制），满足现有 `AGENT_ID_RE = /^[a-z0-9][a-z0-9.-]{2,31}$/`
- fanout N 行 INSERT 必须单事务，bus 事件在 commit 之后发出
- 幂等前缀查重**不用 LIKE**（cmid 含 `%`/`_` 会成通配符）——用 `substr(client_msg_id,1,?)=?` 精确比较
- 64KB 文本上限按**原始 text** 计（UTF-8 字节，`Buffer.byteLength`），封皮不计
- 群发按 1 条限流预算（fanout 内部 INSERT 不重复计费）
- 错误码风格沿用 `Errors.*`；新增校验失败用现有 400/403/404/410 语义
- 归属（owner）注册时定死，无运行时转移 API；`AGENTLINK_REG_CODES` 存在时 open registration 必须拒绝
- audit：建/改/解散群、拉/移成员、群发各落一条 `audit_log`

## Review Focus

1. **cmid ≥63 字符的 fanout 后缀**——截断规则若与幂等查重不同源，重试会撞唯一索引 500。查重前缀与写入 cmid 一律从同一截断基推导，且并发撞 `idx_messages_idem` 必须落 dedup。Task 4 测试钉死「63 字符 cmid 截断后重试 0 新行」+「并发约束冲突落 dedup」。
2. **解散群后发送/拉人**——成员已清空，`getAgent` 仍能找到伪 agent；缺 410 判定会静默落库不投递（WS 幽灵收件人同类）。Task 3/4 测试钉死。
3. **群伪 agent 出现在普通 DM 路径**——`im send` 打 `POST /v1/messages`，若拦截只查 groups 端点，`to=grp.x` 走 sendMessage 直插单行永不投递。Task 5 双入口一致性测试钉死。
4. **file 群消息**——sendMessage 的 `FILE_RECIPIENT_MISMATCH` 语义（file 行 to=grp）与成员行 to=成员天然不一致，sendGroupMessage 必须有独立 file 分支。Task 4 测试钉死。
5. **并发同 cmid 重试**——两个请求同 (from, cmid) 撞唯一索引必须被 SQLITE_CONSTRAINT catch 兜住重查：同群落 dedup、跨群 409，不许 500。Task 4「跨群复用」测试钉住 catch 路径（同群并发路径与 dedup 前置检查共用 findExisting，无法在单连接测试中真实并发触发）。

---

### Task 1: schema v8 迁移（role/owner/group 表）

**Files:**
- Modify: `server/src/db/schema.ts`（migrate 签名 + v8 块）
- Modify: `server/src/index.ts`（启动传 defaultOwner）
- Test: `server/test/schema-v8.test.ts`

**Interfaces:**
- Produces: `migrate(db: Db, opts: { defaultOwner?: string } = {}): void`（向后兼容：不传 opts 行为=旧行，owner 留 ''）
- Produces: 表 `groups(id, owner, created_at)`、`group_members(group_id, agent_id, joined_at)`、`agent_notes(human_id, agent_id, note, updated_at)`、列 `agents.role`/`agents.owner`/`messages.group_id`、索引 `idx_messages_group`

- [ ] **Step 1: 写失败测试**

```ts
// server/test/schema-v8.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { openDb, migrate } from '../src/db/sqlite.js'

const db0 = () => { const db = openDb(join(mkdtempSync(join(tmpdir(), 'v8-')), 't.db')); return db }

describe('schema v8', () => {
  it('v8 增列与新表齐全，user_version=8', () => {
    const db = db0(); migrate(db, { defaultOwner: 'kt.human' })
    expect((db.prepare('PRAGMA user_version').get() as any).user_version).toBe(8)
    const cols = (db.prepare("SELECT name FROM pragma_table_info('agents')").all() as any[]).map(r => r.name)
    expect(cols).toContain('role'); expect(cols).toContain('owner')
    const mcols = (db.prepare("SELECT name FROM pragma_table_info('messages')").all() as any[]).map(r => r.name)
    expect(mcols).toContain('group_id')
    for (const t of ['groups', 'group_members', 'agent_notes']) expect(db.prepare(`SELECT 1 FROM ${t}`).get()).toBeTruthy()
  })
  it('存量 agent 回填 owner=defaultOwner，role 缺省 agent，server 行也在内', () => {
    // migrate 首跑即完成全部版本块（含 v8 列）；回填在版本门之外按 WHERE owner='' 幂等执行，
    // 所以「先迁移→后插行→再迁移」也能回填（r1-C1：原设计把回填放版本门内则此路径必挂）
    const db = db0(); migrate(db)
    db.prepare(`INSERT INTO agents (id, display_name, description, capabilities, task_policy, created_at, last_seen_at) VALUES ('old.a','a','','[]','{}','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`).run()
    migrate(db, { defaultOwner: 'kt.human' })
    expect((db.prepare(`SELECT owner FROM agents WHERE id='old.a'`).get() as any).owner).toBe('kt.human')
    expect((db.prepare(`SELECT role FROM agents WHERE id='old.a'`).get() as any).role).toBe('agent')
    expect((db.prepare(`SELECT owner FROM agents WHERE id='server'`).get() as any).owner).toBe('kt.human')
  })
  it('不传 defaultOwner：owner 留空串不炸；回填幂等且不覆盖非空 owner', () => {
    const db = db0(); migrate(db)
    expect((db.prepare(`SELECT owner FROM agents WHERE id='server'`).get() as any).owner).toBe('')
    db.prepare(`UPDATE agents SET owner='someone.else' WHERE id='server'`).run()
    migrate(db, { defaultOwner: 'kt.human' }) // 非空 owner 不覆盖
    expect((db.prepare(`SELECT owner FROM agents WHERE id='server'`).get() as any).owner).toBe('someone.else')
    db.prepare(`INSERT INTO agents (id, display_name, description, capabilities, task_policy, created_at, last_seen_at) VALUES ('old.b','b','','[]','{}','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`).run()
    migrate(db, { defaultOwner: 'kt.human' }) // 新增的空 owner 行照样回填（版本门外）
    expect((db.prepare(`SELECT owner FROM agents WHERE id='old.b'`).get() as any).owner).toBe('kt.human')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run test/schema-v8.test.ts`
Expected: FAIL（user_version=7 / pragma_table_info 无 role 列报错）

- [ ] **Step 3: 实现 v8 块**

`server/src/db/schema.ts`：签名改 `export function migrate(db: Db, opts: { defaultOwner?: string } = {}): void`；v7 块之后追加（与既有块同结构）：

```ts
  // v1.7 迁移：人类观测台+群聊（spec 2026-10-22-human-console-groupchat-design.md §2）
  // role: agent|human|group（伪 agent）；owner=归属人类 id，注册码定死；migrate 只接收参数不读 env（r2-N6）
  if (v < 8) {
    db.transaction(() => {
      db.exec(`
      ALTER TABLE agents ADD COLUMN role TEXT NOT NULL DEFAULT 'agent';
      ALTER TABLE agents ADD COLUMN owner TEXT NOT NULL DEFAULT '';
      ALTER TABLE messages ADD COLUMN group_id TEXT NOT NULL DEFAULT '';
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL REFERENCES agents(id),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS group_members (
        group_id TEXT NOT NULL REFERENCES groups(id),
        agent_id TEXT NOT NULL REFERENCES agents(id),
        joined_at TEXT NOT NULL,
        PRIMARY KEY (group_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS agent_notes (
        human_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (human_id, agent_id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id, id) WHERE group_id != '';
      `)
      db.prepare('PRAGMA user_version = 8').run()
    })()
  }
  // 回填放在 migrate 函数最末（server 系统行 INSERT 之后）、且在版本门之外（r1-C1）：
  // 幂等、靠 WHERE owner='' 防覆盖——既覆盖「升级后才配 defaultOwner」的存量库，
  // 也保证 migrate(db,{defaultOwner}) 单次首跑连 server 行一并回填；
  // server 行 owner=defaultOwner 可接受（权限判定按 role，不看 owner）
  if (opts.defaultOwner) db.prepare(`UPDATE agents SET owner=? WHERE owner=''`).run(opts.defaultOwner)
```

`server/src/index.ts`：找到 `migrate(db)` 调用改为 `migrate(db, { defaultOwner: cfg.defaultOwner })`（cfg.defaultOwner 在 Task 2 添加；本 task 先用 `process.env.AGENTLINK_DEFAULT_OWNER ?? undefined` 内联，Task 2 统一收进 config）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && npx vitest run test/schema-v8.test.ts`
Expected: PASS 3/3。再跑 `npx vitest run` 全量确认无回归（旧测试走 `migrate(db)` 新签名兼容）。

- [ ] **Step 5: Commit**

```bash
git add server/src/db/schema.ts server/src/index.ts server/test/schema-v8.test.ts
git commit -m "feat(server): schema v8 — agents.role/owner + groups/group_members/agent_notes"
```

### Task 2: 分码注册与 role 对齐

**Files:**
- Modify: `server/src/config.ts`（regCodes/humanIds/defaultOwner）
- Modify: `server/src/core/agents.ts`（registerAgent owner 映射 + open-reg 互斥 + rowToAgent 带 role/owner + alignRoles）
- Modify: `server/src/index.ts`（启动 alignRoles + migrate 用 cfg.defaultOwner）
- Test: `server/test/reg-codes.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `agents.role`/`agents.owner` 列
- Produces: `Config` 新字段 `regCodes: Map<string,string>`（code→owner）、`humanIds: string[]`、`defaultOwner: string | null`；`alignRoles` 供 index.ts 启动与 Task 5 测试 helper 复用
- Produces: `alignRoles(db: Db, humanIds: string[]): void`（HUMAN_IDS 内 agent 置 role='human'，幂等）
- Produces: `Agent` 接口加 `role: string; owner: string`；`registerAgent` 落 role='agent' + owner

- [ ] **Step 1: 写失败测试**

```ts
// server/test/reg-codes.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { openDb, migrate } from '../src/db/sqlite.js'
import { loadConfig } from '../src/config.js'
import { registerAgent, getAgent, alignRoles } from '../src/core/agents.js'

const setup = (env: Record<string, string> = {}) => {
  const cfg = loadConfig({ REGISTRATION_CODE: 'x', PORT: '0', ...env } as never)
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'rc-')), 't.db')); migrate(db, { defaultOwner: cfg.defaultOwner ?? undefined })
  return { cfg, db }
}

describe('分码注册', () => {
  it('AGENTLINK_REG_CODES：码A→owner=kt.human，码B→owner=zhy.human，错码 403', () => {
    const { cfg, db } = setup({ AGENTLINK_REG_CODES: 'kt.human:CODE_A,zhy.human:CODE_B' })
    const a = registerAgent(db, cfg, { agent_id: 'kt.bot1', registration_code: 'CODE_A' })
    expect(getAgent(db, 'kt.bot1').owner).toBe('kt.human')
    registerAgent(db, cfg, { agent_id: 'zhy.bot1', registration_code: 'CODE_B' })
    expect(getAgent(db, 'zhy.bot1').owner).toBe('zhy.human')
    expect(() => registerAgent(db, cfg, { agent_id: 'bad.x', registration_code: 'WRONG' })).toThrowError(/forbidden|registration/i)
  })
  it('分码与 open registration 互斥：无码注册拒绝', () => {
    const { cfg, db } = setup({ AGENTLINK_REG_CODES: 'kt.human:CODE_A', ALLOW_OPEN_REGISTRATION: 'true' })
    expect(() => registerAgent(db, cfg, { agent_id: 'open.x' })).toThrowError(/分码|registration/i)
  })
  it('旧单码 REGISTRATION_CODE → owner=defaultOwner（AGENTLINK_DEFAULT_OWNER，缺省 humanIds[0]）', () => {
    const { cfg, db } = setup({ AGENTLINK_DEFAULT_OWNER: 'zhy.human' })
    registerAgent(db, cfg, { agent_id: 'old.bot', registration_code: 'x' })
    expect(getAgent(db, 'old.bot').owner).toBe('zhy.human')
    const c2 = loadConfig({ REGISTRATION_CODE: 'x', PORT: '0', AGENTLINK_HUMAN_IDS: 'kt.human,zhy.human' } as never)
    expect(c2.defaultOwner).toBe('kt.human') // 缺省取 HUMAN_IDS 第一个
  })
  it('alignRoles：HUMAN_IDS 内置 role=human，幂等', () => {
    const { cfg, db } = setup({ AGENTLINK_HUMAN_IDS: 'kt.human,zhy.human' })
    registerAgent(db, cfg, { agent_id: 'kt.human', registration_code: 'x' })
    alignRoles(db, cfg.humanIds); alignRoles(db, cfg.humanIds)
    expect(getAgent(db, 'kt.human').role).toBe('human')
    expect(getAgent(db, 'server').role).toBe('agent')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run test/reg-codes.test.ts`
Expected: FAIL（cfg.regCodes/defaultOwner 不存在、owner 列查询为 undefined 等）

- [ ] **Step 3: 实现**

`config.ts`：

```ts
// 接口加：regCodes: Map<string,string>; humanIds: string[]; defaultOwner: string | null
const regCodes = new Map<string, string>()
for (const pair of (env.AGENTLINK_REG_CODES || '').split(',').map(s => s.trim()).filter(Boolean)) {
  const i = pair.lastIndexOf(':'); if (i > 0) regCodes.set(pair.slice(i + 1), pair.slice(0, i))
}
const humanIds = (env.AGENTLINK_HUMAN_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
// 导出对象加：
regCodes,
humanIds,
defaultOwner: env.AGENTLINK_DEFAULT_OWNER || humanIds[0] || null,
```

`agents.ts`：`Agent` 接口与 `rowToAgent` 加 `role: r.role ?? 'agent'`、`owner: r.owner ?? ''`；`registerAgent` 开头改：

```ts
  let owner: string
  if (cfg.regCodes.size) {
    owner = cfg.regCodes.get(input.registration_code ?? '') ?? ''
    if (!owner) throw Errors.forbidden('invalid registration code') // 分码即归属，无码无归属
  } else {
    if (!cfg.registrationCode && !cfg.allowOpenRegistration) throw Errors.registrationClosed()
    if (cfg.registrationCode && input.registration_code !== cfg.registrationCode) throw Errors.forbidden('invalid registration code')
    if (!cfg.registrationCode) throw Errors.invalidRequest('本部署已启用分码注册') // open reg 与分码互斥（r1-Minor3）
    owner = cfg.defaultOwner ?? ''
  }
```

INSERT 语句加 `role`/`owner` 两列（值 `'agent'`/`owner`）；末尾加：

```ts
// role 对齐主体=server（r2-N4）：启动时按 HUMAN_IDS 置 human；客户端惰性仅显示兜底
export function alignRoles(db: Db, humanIds: string[]): void {
  for (const id of humanIds) db.prepare(`UPDATE agents SET role='human' WHERE id=?`).run(id)
}
```

`index.ts`：启动处 `alignRoles(db, cfg.humanIds)`（migrate 之后）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && npx vitest run test/reg-codes.test.ts && npx vitest run`
Expected: PASS 4/4 + 全量绿（旧注册测试仍走单码路径）

- [ ] **Step 5: Commit**

```bash
git add server/src/config.ts server/src/core/agents.ts server/src/index.ts server/test/reg-codes.test.ts
git commit -m "feat(server): 分码注册即归属 + role 列 + alignRoles"
```

### Task 3: groups core（CRUD/可见性/时间线）

**Files:**
- Create: `server/src/core/groups.ts`
- Modify: `server/src/core/audit.ts:2-15`（AuditEvent 闭集 union 追加 6 个群事件——r1-M3，否则 `tsc --noEmit` 红）
- Test: `server/test/groups-core.test.ts`

**Interfaces:**
- Consumes: Task 1 表；Task 2 `getAgent`（agent 含 role/owner）、`AGENT_ID_RE`、`audit`
- Produces:
  - `GROUP_ID_RE = /^grp\.[0-9a-f]{8}$/`
  - `createGroup(db, owner, {name, members}): {id}` — members 去重校验均存在，建伪 agent `role='group', owner, display_name=name`
  - `membersOf(db, groupId): string[]`；`isDissolved(db, groupId): boolean`（成员 0 即解散态）
  - `visibleTo(db, groupId, requesterId): boolean` — requester 是成员 agent，或 human（role='human'）且（建群者 或 有 `owner==requester` 的成员 agent）
  - `renameGroup(db, actor, groupId, name)`（仅建群者）；`addMember(db, actor, groupId, agentId)`（建群者任意；其他 human 仅 own agent）；`removeMember(db, actor, groupId, agentId)`（建群者任意；其他 human 仅 own；**不可移出建群者本人**——否则出现「非解散路径的 0 成员态」，r1-Minor9）；`dissolveGroup(db, actor, groupId)`（仅建群者，清空成员）
  - `AuditEvent` 新增 6 值：`'group.created' | 'group.renamed' | 'group.member_added' | 'group.member_removed' | 'group.dissolved' | 'group.message_sent'`
  - `listGroupsFor(db, humanId): {id, name, owner, mine_members: string[]}[]`
  - `groupTimeline(db, groupId, {after?, limit}): Message[]`（`WHERE group_id=? AND id > ?` 正序）

- [ ] **Step 1: 写失败测试**

```ts
// server/test/groups-core.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { openDb, migrate } from '../src/db/sqlite.js'
import { loadConfig } from '../src/config.js'
import { registerAgent, getAgent, alignRoles } from '../src/core/agents.js'
import { createGroup, membersOf, isDissolved, visibleTo, renameGroup, addMember, removeMember, dissolveGroup, listGroupsFor, groupTimeline, GROUP_ID_RE } from '../src/core/groups.js'

const setup = () => {
  // r1-C4：必须走分码注册——单码下所有 agent owner 都是 kt.human，
  // visibleTo(zhy.human)/mineOnly 分叉断言全部失效。分码正是 Task 2 已实现的能力，测试消费它
  const cfg = loadConfig({ AGENTLINK_REG_CODES: 'kt.human:KA,zhy.human:ZB', PORT: '0', AGENTLINK_HUMAN_IDS: 'kt.human,zhy.human' } as never)
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'gp-')), 't.db')); migrate(db)
  const mk = (id: string, owner: 'kt' | 'zhy' = 'kt') => registerAgent(db, cfg, { agent_id: id, registration_code: owner === 'kt' ? 'KA' : 'ZB' })
  mk('kt.human'); mk('kt.a1'); mk('zhy.human', 'zhy'); mk('zhy.a1', 'zhy'); alignRoles(db, cfg.humanIds)
  return { db, mk }
}

describe('groups core', () => {
  it('建群：伪 agent role=group 无 token，members 快照；统一拉任意 agent（跨 owner）', () => {
    const { db } = setup()
    const g = createGroup(db, 'kt.human', { name: '作战室', members: ['kt.a1', 'zhy.a1'] })
    expect(GROUP_ID_RE.test(g.id)).toBe(true)
    const ga = getAgent(db, g.id)
    expect(ga.role).toBe('group'); expect(ga.owner).toBe('kt.human'); expect(ga.display_name).toBe('作战室')
    expect((db.prepare('SELECT COUNT(*) c FROM tokens WHERE agent_id=?').get(g.id) as any).c).toBe(0) // 不发 token
    expect(membersOf(db, g.id).sort()).toEqual(['kt.a1', 'kt.human', 'zhy.a1']) // r1-M2：建群者入 members
  })
  it('可见性：成员 agent 可见；建群 human 可见；有 mine 成员的另一 human 可见；无关 human 不可见', () => {
    const { db } = setup()
    const g = createGroup(db, 'kt.human', { name: 'g', members: ['kt.a1', 'zhy.a1'] })
    expect(visibleTo(db, g.id, 'kt.a1')).toBe(true)
    expect(visibleTo(db, g.id, 'kt.human')).toBe(true)   // 建群者
    expect(visibleTo(db, g.id, 'zhy.human')).toBe(true)  // zhy.a1 是 mine
    expect(visibleTo(db, g.id, 'server')).toBe(false)
  })
  it('权限分叉：建群者拉任意/移任意/改名/解散；其他 human 只能动自己的 agent', () => {
    const { db } = setup()
    const g = createGroup(db, 'kt.human', { name: 'g', members: ['kt.a1'] })
    addMember(db, 'kt.human', g.id, 'zhy.a1')                     // 建群者拉任意
    expect(() => addMember(db, 'zhy.human', g.id, 'kt.a1')).toThrow() // zhy 再拉 kt 的 → 拒
    expect(() => addMember(db, 'zhy.human', g.id, 'zhy.a1')).not.toThrow() // 冗余添加自己人 = 幂等跳过
    removeMember(db, 'zhy.human', g.id, 'zhy.a1')                 // 移自己的
    expect(() => removeMember(db, 'zhy.human', g.id, 'kt.a1')).toThrow()
    expect(() => removeMember(db, 'kt.human', g.id, 'kt.human')).toThrow() // r1-Minor9：建群者本人不可被移出
    renameGroup(db, 'kt.human', g.id, '新名'); expect(getAgent(db, g.id).display_name).toBe('新名')
    expect(() => renameGroup(db, 'zhy.human', g.id, 'x')).toThrow()
    dissolveGroup(db, 'kt.human', g.id)
    expect(isDissolved(db, g.id)).toBe(true)
    expect(getAgent(db, g.id).role).toBe('group')                  // 伪 agent 行保留（FK 完整）
  })
  it('listGroupsFor：kt.human 看到两个群（建群 + mine 成员）', () => {
    const { db } = setup()
    const g1 = createGroup(db, 'kt.human', { name: 'a', members: ['kt.a1'] })
    const g2 = createGroup(db, 'zhy.human', { name: 'b', members: ['zhy.a1', 'kt.a1'] })
    const ids = listGroupsFor(db, 'kt.human').map(g => g.id).sort()
    expect(ids).toEqual([g1.id, g2.id].sort())
  })
  it('groupTimeline：按 group_id 过滤正序，after 增量', () => {
    const { db } = setup()
    const g = createGroup(db, 'kt.human', { name: 'g', members: ['kt.a1'] })
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO messages (id, client_msg_id, from_agent, to_agent, type, body, thread_id, topic, created_at, group_id) VALUES ('m1','c1','kt.human','kt.a1','text','{}',NULL,'g-ab12cd34',?,'${g.id}')`).run(now)
    db.prepare(`INSERT INTO messages (id, client_msg_id, from_agent, to_agent, type, body, thread_id, topic, created_at) VALUES ('m2','c2','kt.a1','zhy.a1','text','{}',NULL,'_default',?)`).run(now)
    const rows = groupTimeline(db, g.id, { limit: 10 })
    expect(rows.map(r => r.id)).toEqual(['m1']) // m2 无 group_id 不入群时间线
    expect(groupTimeline(db, g.id, { after: 'm0', limit: 10 }).map(r => r.id)).toEqual(['m1'])
    expect(groupTimeline(db, g.id, { after: 'm1', limit: 10 })).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run test/groups-core.test.ts`
Expected: FAIL（`../src/core/groups.js` 不存在，import 报错）

- [ ] **Step 3: 实现 core/groups.ts**

```ts
// 群聊 core（spec 2026-10-22-human-console-groupchat-design.md §1.3/§2/§3）
// 群=伪 agent（role='group' 无 token）；成员快照存 group_members；解散=清空成员（伪 agent 行保留保 FK）
import { randomBytes } from 'node:crypto'
import type { Db } from '../db/sqlite.js'
import { Errors } from '../http/errors.js'
import { getAgent } from './agents.js'
import { audit } from './audit.js'
import { newMsgId } from './ids.js'

export const GROUP_ID_RE = /^grp\.[0-9a-f]{8}$/

const membersOf = (db: Db, groupId: string): string[] =>
  (db.prepare('SELECT agent_id FROM group_members WHERE group_id=? ORDER BY joined_at, agent_id').all(groupId) as { agent_id: string }[]).map(r => r.agent_id)
const isDissolved = (db: Db, groupId: string): boolean => membersOf(db, groupId).length === 0
const requireGroup = (db: Db, groupId: string) => {
  if (!GROUP_ID_RE.test(groupId)) throw Errors.invalidRequest('group id must match ^grp\\.[0-9a-f]{8}$')
  getAgent(db, groupId) // 404 if unknown
}

export function createGroup(db: Db, owner: string, input: { name: string; members: string[] }): { id: string } {
  if (!input.name || input.name.length > 64) throw Errors.invalidRequest('name required (1-64 chars)')
  // r1-M2：建群者一并入 group_members（spec §1.3 封皮 members=落库时快照，含建群者）——
  // 否则建群人类收不到自己的 fanout 行，M3 console 将看不到自己发过什么
  const members = [...new Set([owner, ...(input.members ?? [])])]
  if (members.length < 2) throw Errors.invalidRequest('members required (>=1 besides creator)') // members 至少 1 个（去重后含 owner 至少 2）
  for (const m of members) getAgent(db, m) // 成员必须存在（404）
  const id = `grp.${randomBytes(4).toString('hex')}`
  const now = new Date().toISOString()
  db.transaction(() => {
    db.prepare(`INSERT INTO agents (id, display_name, description, capabilities, task_policy, created_at, last_seen_at, role, owner) VALUES (?,?,'','[]','{"mode":"closed","allowlist":[],"scope":"read-only"}',?,?, 'group', ?)`)
      .run(id, input.name, now, now, owner)
    db.prepare('INSERT INTO groups (id, owner, created_at) VALUES (?,?,?)').run(id, owner, now)
    for (const m of members) db.prepare('INSERT INTO group_members (group_id, agent_id, joined_at) VALUES (?,?,?)').run(id, m, now)
  })()
  audit(db, owner, 'group.created', { group_id: id, members })
  return { id }
}

// 可见性（spec §1.2）：成员 agent；human 建群者；human 且有 owner==自己 的成员 agent
export function visibleTo(db: Db, groupId: string, requesterId: string): boolean {
  const requester = getAgent(db, requesterId)
  if (membersOf(db, groupId).includes(requesterId)) return true
  if (requester.role !== 'human') return false
  const g = db.prepare('SELECT owner FROM groups WHERE id=?').get(groupId) as { owner: string } | undefined
  if (!g) return false
  if (g.owner === requesterId) return true
  return !!db.prepare(`SELECT 1 FROM group_members gm JOIN agents a ON a.id=gm.agent_id WHERE gm.group_id=? AND a.owner=?`).get(groupId, requesterId)
}

const assertVisible = (db: Db, groupId: string, actor: string) => { if (!visibleTo(db, groupId, actor)) throw Errors.forbidden('group not visible') }
const groupOwner = (db: Db, groupId: string): string => (db.prepare('SELECT owner FROM groups WHERE id=?').get(groupId) as { owner: string }).owner
const mineOnly = (db: Db, agentId: string, actor: string): boolean => (db.prepare('SELECT owner FROM agents WHERE id=?').get(agentId) as any)?.owner === actor

export function renameGroup(db: Db, actor: string, groupId: string, name: string): void {
  requireGroup(db, groupId)
  if (!name || name.length > 64) throw Errors.invalidRequest('name required (1-64 chars)')
  if (groupOwner(db, groupId) !== actor) throw Errors.forbidden('only group owner can rename')
  db.prepare('UPDATE agents SET display_name=? WHERE id=?').run(name, groupId)
  audit(db, actor, 'group.renamed', { group_id: groupId, name })
}

export function addMember(db: Db, actor: string, groupId: string, agentId: string): void {
  requireGroup(db, groupId)
  if (isDissolved(db, groupId)) throw Errors.gone('group dissolved')
  const actorRow = getAgent(db, actor)
  if (actorRow.role === 'human') {
    if (groupOwner(db, groupId) !== actor && !mineOnly(db, agentId, actor)) throw Errors.forbidden('owner can add anyone; others only their own agents')
  } else if (actor !== groupOwner(db, groupId)) throw Errors.forbidden('agents cannot manage members')
  getAgent(db, agentId) // 404 if unknown
  if (agentId.startsWith('grp.')) throw Errors.invalidRequest('cannot add a group into a group')
  const now = new Date().toISOString()
  db.prepare('INSERT OR IGNORE INTO group_members (group_id, agent_id, joined_at) VALUES (?,?,?)').run(groupId, agentId, now)
  audit(db, actor, 'group.member_added', { group_id: groupId, agent_id: agentId })
}

export function removeMember(db: Db, actor: string, groupId: string, agentId: string): void {
  requireGroup(db, groupId)
  if (agentId === groupOwner(db, groupId)) throw Errors.invalidRequest('cannot remove the group creator') // r1-Minor9：唯一合法的空成员路径只有 dissolveGroup
  const actorRow = getAgent(db, actor)
  if (actorRow.role === 'human') {
    if (groupOwner(db, groupId) !== actor && !mineOnly(db, agentId, actor)) throw Errors.forbidden('owner can remove anyone; others only their own agents')
  } else if (actor !== agentId) throw Errors.forbidden('agents can only leave by themselves')
  db.prepare('DELETE FROM group_members WHERE group_id=? AND agent_id=?').run(groupId, agentId)
  audit(db, actor, 'group.member_removed', { group_id: groupId, agent_id: agentId })
}

export function dissolveGroup(db: Db, actor: string, groupId: string): void {
  requireGroup(db, groupId)
  if (groupOwner(db, groupId) !== actor) throw Errors.forbidden('only group owner can dissolve')
  db.prepare('DELETE FROM group_members WHERE group_id=?').run(groupId)
  audit(db, actor, 'group.dissolved', { group_id: groupId })
}

export function listGroupsFor(db: Db, humanId: string): { id: string; name: string; owner: string; mine_members: string[] }[] {
  const rows = db.prepare(`SELECT DISTINCT g.id, a.display_name as name, g.owner FROM groups g
    LEFT JOIN group_members gm ON gm.group_id=g.id
    LEFT JOIN agents m ON m.id=gm.agent_id
    JOIN agents a ON a.id=g.id
    WHERE g.owner=? OR m.owner=?`).all(humanId, humanId) as { id: string; name: string; owner: string }[]
  return rows.map(r => ({ ...r, mine_members: db.prepare(`SELECT gm.agent_id FROM group_members gm JOIN agents x ON x.id=gm.agent_id WHERE gm.group_id=? AND x.owner=?`).all(r.id, humanId).map((x: any) => x.agent_id) }))
}

export function groupTimeline(db: Db, groupId: string, q: { after?: string; limit: number }) {
  const COLS = 'id, client_msg_id, from_agent as `from`, to_agent as `to`, type, body, thread_id, topic, created_at, delivered_at, read_at, group_id'
  const rows = q.after
    ? db.prepare(`SELECT ${COLS} FROM messages WHERE group_id=? AND id > ? ORDER BY id LIMIT ?`).all(groupId, q.after, q.limit)
    : db.prepare(`SELECT ${COLS} FROM messages WHERE group_id=? ORDER BY id LIMIT ?`).all(groupId, q.limit)
  return rows.map((r: any) => ({ ...r, body: JSON.parse(r.body) }))
}

export { membersOf, isDissolved }
```

注：`Errors.gone` 若不存在则在 `http/errors.ts` 加（410 GONE，message 'group dissolved'），与 `Errors.forbidden` 同构。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && npx vitest run test/groups-core.test.ts && npx vitest run`
Expected: PASS 5/5 + 全量绿

- [ ] **Step 5: Commit**

```bash
git add server/src/core/groups.ts server/src/core/audit.ts server/src/http/errors.ts server/test/groups-core.test.ts
git commit -m "feat(server): groups core — 伪 agent 建群/成员权限/可见性/时间线"
```

### Task 4: sendGroupMessage fanout

**Files:**
- Create: `server/src/core/group-send.ts`（独立文件，避免 messages.ts 膨胀）
- Test: `server/test/group-send.test.ts`

**Interfaces:**
- Consumes: Task 3 `membersOf/isDissolved/visibleTo/GROUP_ID_RE`；`getAgent`；`FILE_ID_RE`；`newMsgId`
- Produces: `sendGroupMessage(db: Db, bus: Bus, from: string, input: { to: string; type: 'text'|'file'; body: { text?: string; file_id?: string; note?: string }; client_msg_id: string }): { group_id: string; delivered: number; messages: Message[]; deduplicated: boolean }`
  - 权限：`visibleTo(db, input.to, from)` 否则 403；`isDissolved` → 410
  - 校验：text 按 `Buffer.byteLength(原文) > 64*1024` 拒（封皮不计）；file 查 files 行须 `from_agent===from && to_agent===input.to`
  - fanout：单事务插 N 行（N=成员数，**含建群者 human**——Task 3 createGroup 已把 owner 写入 group_members，r1-M2）；每行 `to=<成员>`、`group_id`、`topic='g-'+id.slice(4)`、cmid=`<截断基>:<i>`（≤64，截断基=cmid 本身或其前 62 字符）、body={...原body, group:{id,name,members快照(含 human 成员)}}
  - 幂等：查重前缀与写入 cmid **同源**（一律从截断基推导，r1-M1）、按 `(from_agent, group_id)` 过滤、`substr` 精确比较 + 后缀首字符为数字（不走 LIKE，r2-N2）→ 命中返回既有行 deduplicated；幂等检查先于可见性/解散检查（**裁决：幂等优先，向已解散群重放旧 cmid 返回 dedup 而非 410**，r1-Minor3）；INSERT 事务包 SQLITE_CONSTRAINT catch——重查命中本群落 dedup（并发同 cmid），命中他群抛 409（跨群复用 cmid）
  - commit 后逐成员 `bus.emit({type:'new-message', agentId:成员, message})`；audit 一条

- [ ] **Step 1: 写失败测试**

```ts
// server/test/group-send.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { openDb, migrate } from '../src/db/sqlite.js'
import { loadConfig } from '../src/config.js'
import { registerAgent, alignRoles, getAgent } from '../src/core/agents.js'
import { createGroup } from '../src/core/groups.js'
import { sendGroupMessage } from '../src/core/group-send.js'
import { Bus } from '../src/core/bus.js'

const setup = () => {
  const cfg = loadConfig({ REGISTRATION_CODE: 'x', PORT: '0', AGENTLINK_HUMAN_IDS: 'kt.human' } as never)
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'gs-')), 't.db')); migrate(db, { defaultOwner: 'kt.human' })
  const mk = (id: string) => registerAgent(db, cfg, { agent_id: id, registration_code: 'x' })
  mk('kt.human'); mk('kt.a1'); mk('kt.a2'); alignRoles(db, cfg.humanIds)
  return { db, mk, bus: new Bus() }
}

describe('sendGroupMessage fanout', () => {
  it('N=成员数 fanout 行（含建群者 human，r1-M2）：group_id/topic/封皮 members 快照；bus commit 后逐成员发', () => {
    const { db, bus } = setup()
    const g = createGroup(db, 'kt.human', { name: '作战室', members: ['kt.a1', 'kt.a2'] })
    const events: any[] = []; bus.on(e => events.push(e))
    const out = sendGroupMessage(db, bus, 'kt.human', { to: g.id, type: 'text', body: { text: '开会' }, client_msg_id: 'c1' })
    expect(out.delivered).toBe(3); expect(out.deduplicated).toBe(false) // owner+a1+a2
    const rows = db.prepare(`SELECT * FROM messages WHERE group_id=? ORDER BY id`).all(g.id) as any[]
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map(r => r.to_agent))).toEqual(new Set(['kt.human', 'kt.a1', 'kt.a2']))
    expect(rows[0].topic).toBe('g-' + g.id.slice(4)) // 定稿 topic = 'g-<8hex>'
    for (const r of rows) {
      const body = JSON.parse(r.body)
      expect(body.text).toBe('开会')
      expect(body.group).toEqual({ id: g.id, name: '作战室', members: ['kt.a1', 'kt.human', 'kt.a2'].sort() })
    }
    expect(events.filter(e => e.type === 'new-message')).toHaveLength(3) // commit 后 bus
  })
  it('重试同 cmid：0 新行 deduplicated=true 返回既有', () => {
    const { db, bus } = setup()
    const g = createGroup(db, 'kt.human', { name: 'g', members: ['kt.a1', 'kt.a2'] })
    sendGroupMessage(db, bus, 'kt.human', { to: g.id, type: 'text', body: { text: 'x' }, client_msg_id: 'same' })
    const r2 = sendGroupMessage(db, bus, 'kt.human', { to: g.id, type: 'text', body: { text: 'x' }, client_msg_id: 'same' })
    expect(r2.deduplicated).toBe(true)
    expect((db.prepare(`SELECT COUNT(*) c FROM messages WHERE group_id=?`).get(g.id) as any).c).toBe(3)
  })
  it('cmid 63 字符：截断到 62 基 + 后缀，查重与写入同源，重试幂等（r1-M1）', () => {
    const { db, bus } = setup()
    const g = createGroup(db, 'kt.human', { name: 'g', members: ['kt.a1'] })
    const cmid = 'x'.repeat(63) // 63+2=65 > 64 → 触发截断基 62
    sendGroupMessage(db, bus, 'kt.human', { to: g.id, type: 'text', body: { text: 'x' }, client_msg_id: cmid })
    const row = db.prepare(`SELECT client_msg_id FROM messages WHERE group_id=? LIMIT 1`).get(g.id) as any
    expect(row.client_msg_id.length).toBe(64) // 62 基 + ':0'
    expect(row.client_msg_id.startsWith(cmid.slice(0, 62) + ':')).toBe(true)
    const r2 = sendGroupMessage(db, bus, 'kt.human', { to: g.id, type: 'text', body: { text: 'x' }, client_msg_id: cmid })
    expect(r2.deduplicated).toBe(true) // 查重用同一截断基，否则这里会撞唯一索引 500
    expect((db.prepare(`SELECT COUNT(*) c FROM messages WHERE group_id=?`).get(g.id) as any).c).toBe(2) // owner+a1
  })
  it('cmid 含 % 与 _：前缀查重不走 LIKE，不误伤', () => {
    const { db, bus } = setup()
    const g = createGroup(db, 'kt.human', { name: 'g', members: ['kt.a1'] })
    sendGroupMessage(db, bus, 'kt.human', { to: g.id, type: 'text', body: { text: 'a' }, client_msg_id: 'we%ird_cmid' })
    const r = sendGroupMessage(db, bus, 'kt.human', { to: g.id, type: 'text', body: { text: 'b' }, client_msg_id: 'weXirdZcmid' })
    expect(r.deduplicated).toBe(false) // % 当字面量，不匹配别条
    expect((db.prepare(`SELECT COUNT(*) c FROM messages WHERE group_id=?`).get(g.id) as any).c).toBe(4) // 2 发 × (owner+a1)
  })
  it('跨群复用同 cmid：群 A 成功，群 B 撞唯一索引 → 409 拒，不误 dedup 不串群（r1-M1）', () => {
    const { db, bus } = setup()
    const g1 = createGroup(db, 'kt.human', { name: 'g1', members: ['kt.a1'] })
    const g2 = createGroup(db, 'kt.human', { name: 'g2', members: ['kt.a2'] })
    sendGroupMessage(db, bus, 'kt.human', { to: g1.id, type: 'text', body: { text: 'x' }, client_msg_id: 'dup' })
    expect(() => sendGroupMessage(db, bus, 'kt.human', { to: g2.id, type: 'text', body: { text: 'x' }, client_msg_id: 'dup' })).toThrowError(/reused|another group/i)
    expect((db.prepare(`SELECT COUNT(*) c FROM messages WHERE group_id=?`).get(g2.id) as any).c).toBe(0)
  })
  it('权限：非成员 agent 403；解散 410；text>64KB 拒（按原文计，封皮不计）', () => {
    const { db, bus, mk } = setup()
    mk('other.agent')
    const g = createGroup(db, 'kt.human', { name: 'g', members: ['kt.a1'] })
    expect(() => sendGroupMessage(db, bus, 'other.agent', { to: g.id, type: 'text', body: { text: 'x' }, client_msg_id: 'c' })).toThrowError(/forbidden/i)
    const g2 = createGroup(db, 'kt.human', { name: 'g2', members: ['kt.a1'] })
    db.prepare('DELETE FROM group_members WHERE group_id=?').run(g2.id)
    expect(() => sendGroupMessage(db, bus, 'kt.human', { to: g2.id, type: 'text', body: { text: 'x' }, client_msg_id: 'c' })).toThrowError(/dissolved|gone/i)
    expect(() => sendGroupMessage(db, bus, 'kt.human', { to: g.id, type: 'text', body: { text: '汉'.repeat(21846) }, client_msg_id: 'c9' })).toThrowError(/64KB|payload/i)
  })
  it('file 分支：file 行 to=grp 校验通过则成员行拷贝封皮；file 行 to=个人 → 拒', () => {
    const { db, bus } = setup()
    const g = createGroup(db, 'kt.human', { name: 'g', members: ['kt.a1'] })
    const now = new Date().toISOString()
    const ins = (fid: string, to: string) => db.prepare(`INSERT INTO files (id, from_agent, to_agent, name, size, sha256, created_at, expires_at) VALUES (?, 'kt.human', ?, 'f', 1, 'abc', ?, '2999-01-01T00:00:00Z')`).run(fid, to, now)
    ins('file_AAAA', g.id); ins('file_BBBB', 'kt.a1')
    const ok = sendGroupMessage(db, bus, 'kt.human', { to: g.id, type: 'file', body: { file_id: 'file_AAAA' }, client_msg_id: 'cf' })
    expect(ok.delivered).toBe(2) // owner+a1
    const body = JSON.parse((db.prepare(`SELECT body FROM messages WHERE group_id=? LIMIT 1`).get(g.id) as any).body)
    expect(body.file_id).toBe('file_AAAA'); expect(body.group.id).toBe(g.id)
    expect(() => sendGroupMessage(db, bus, 'kt.human', { to: g.id, type: 'file', body: { file_id: 'file_BBBB' }, client_msg_id: 'cf2' })).toThrowError(/RECIPIENT|file/i)
  })
  it('成员 agent 也可群发（from=kt.a1），自持行在 fanout 内', () => {
    const { db, bus } = setup()
    const g = createGroup(db, 'kt.human', { name: 'g', members: ['kt.a1', 'kt.a2'] })
    const out = sendGroupMessage(db, bus, 'kt.a1', { to: g.id, type: 'text', body: { text: 'hi' }, client_msg_id: 'ca' })
    expect(out.delivered).toBe(3) // owner + a1 自持行 + a2 行
    const rows = db.prepare(`SELECT to_agent FROM messages WHERE group_id=?`).all(g.id) as any[]
    expect(new Set(rows.map(r => r.to_agent))).toEqual(new Set(['kt.human', 'kt.a1', 'kt.a2']))
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run test/group-send.test.ts`
Expected: FAIL（group-send.ts 不存在）

- [ ] **Step 3: 实现 core/group-send.ts**

```ts
// 群发 core（spec §1.3/§2 fanout 决策，r1-M4/r2-N2/N3）
// 单事务 N 行 → commit 后 bus；幂等前缀精确比较（不走 LIKE）；64KB 按原文计封皮不计
import type { Db } from '../db/sqlite.js'
import type { Bus } from './bus.js'
import { Errors } from '../http/errors.js'
import { getAgent } from './agents.js'
import { newMsgId, sha256Hex } from './ids.js'
import { FILE_ID_RE } from './files.js'
import { audit } from './audit.js'
import { membersOf, isDissolved, visibleTo } from './groups.js'

interface FanoutMessage { id: string; client_msg_id: string; from: string; to: string; type: string; body: any; topic: string; created_at: string }

// fanout 行 cmid：一律基于截断基（cmid 本身，或 >62 时取前 62）拼 ':<i>'——查重与写入共用同一截断基（r1-M1）
function cmidBase(cmid: string): string { return cmid.length + 2 <= 64 ? cmid : cmid.slice(0, 62) }
function fanoutCmid(cmid: string, i: number): string { return cmidBase(cmid) + ':' + i }

export function sendGroupMessage(db: Db, bus: Bus, from: string, input: { to: string; type: 'text' | 'file'; body: { text?: string; file_id?: string; note?: string }; client_msg_id: string }): { group_id: string; delivered: number; messages: FanoutMessage[]; deduplicated: boolean } {
  if (!input.client_msg_id || input.client_msg_id.length > 64) throw Errors.invalidRequest('client_msg_id required (1-64 chars)')
  // 幂等：精确前缀比较（substr，非 LIKE——cmid 可含 %/_ 通配符，r2-N2）；
  // 前缀 = 截断基+':'，且后缀首字符必须是数字（防 'abc:' 误吞 'abc:xyz' 同前缀行）；
  // 按 (from_agent, group_id) 过滤（r1-M1：跨群复用不误 dedup）
  const prefix = cmidBase(input.client_msg_id) + ':'
  const findExisting = (): FanoutMessage[] =>
    (db.prepare(`SELECT * FROM messages WHERE from_agent=? AND group_id=? AND substr(client_msg_id,1,?)=? AND substr(client_msg_id,?,1) BETWEEN '0' AND '9' ORDER BY id`)
      .all(from, input.to, prefix.length, prefix, prefix.length + 1) as any[]).map(rowToOut)
  const existing = findExisting()
  if (existing.length) return { group_id: input.to, delivered: existing.length, messages: existing, deduplicated: true }
  // 裁决（r1-Minor3）：幂等优先于可见性/解散——向已解散群重放旧 cmid 返回 dedup 而非 410
  if (!visibleTo(db, input.to, from)) throw Errors.forbidden('group not visible')
  if (isDissolved(db, input.to)) throw Errors.gone('group dissolved')

  let baseBody: Record<string, unknown>
  if (input.type === 'file') {
    const fid = input.body.file_id
    if (typeof fid !== 'string' || !FILE_ID_RE.test(fid)) throw Errors.invalidRequest('body.file_id required')
    const row = db.prepare('SELECT * FROM files WHERE id=?').get(fid) as { from_agent: string; to_agent: string; name: string; size: number; sha256: string | null; expires_at: string } | undefined
    if (!row || row.sha256 == null || new Date(row.expires_at).getTime() <= Date.now()) throw Errors.invalidRequest('file not found / not ready / expired')
    if (row.from_agent !== from || row.to_agent !== input.to) throw Errors.badRequest('FILE_RECIPIENT_MISMATCH', 'file recipient must be the group') // r2-N3：群 file 行 to=群
    baseBody = { file_id: fid, name: row.name, size: row.size, sha256: row.sha256 }
  } else {
    if (Buffer.byteLength(input.body.text ?? '') > 64 * 1024) throw Errors.payloadTooLarge('text > 64KB') // 按原文，封皮不计
    baseBody = { text: input.body.text }
  }

  const members = membersOf(db, input.to)           // 成员快照（agent+human，spec §1.3）
  const groupAgent = getAgent(db, input.to)          // display_name=群名
  const envelope = { id: input.to, name: groupAgent.display_name, members }
  const body = JSON.stringify({ ...baseBody, group: envelope })
  const topic = 'g-' + input.to.slice(4)
  const now = new Date().toISOString()
  const out: FanoutMessage[] = []
  try {
    db.transaction(() => {
      members.forEach((m, i) => {
        const id = newMsgId()
        db.prepare(`INSERT INTO messages (id, client_msg_id, from_agent, to_agent, type, body, thread_id, topic, created_at, group_id) VALUES (?,?,?,?,?, ?, NULL, ?, ?, ?)`)
          .run(id, fanoutCmid(input.client_msg_id, i), from, m, input.type, body, topic, now, input.to)
        out.push({ id, client_msg_id: fanoutCmid(input.client_msg_id, i), from, to: m, type: input.type, body: JSON.parse(body), topic, created_at: now })
      })
    })() // 事务提交后 bus（观察者不读半批，spec §2）
  } catch (e: any) {
    // r1-M1 / Review Focus #5：并发同 cmid 撞 idx_messages_idem（schema.ts:35 UNIQUE(from,cmid) 全局）必须落兜底——
    // 重查本群命中 → dedup；仍无本群行 → 同 (from,cmid) 在别群 → 409 拒（跨群复用）
    if (!String(e?.code ?? '').startsWith('SQLITE_CONSTRAINT')) throw e
    const again = findExisting()
    if (again.length) return { group_id: input.to, delivered: again.length, messages: again, deduplicated: true }
    throw Errors.badRequest('CLIENT_MSG_ID_REUSED', 'client_msg_id already used in another group')
  }
  audit(db, from, 'group.message_sent', { group_id: input.to, delivered: out.length, body_sha256: sha256Hex(JSON.stringify(input.body)) })
  for (const msg of out) bus.emit({ type: 'new-message', agentId: msg.to, message: msg as never })
  return { group_id: input.to, delivered: out.length, messages: out, deduplicated: false }
}

const rowToOut = (r: any): FanoutMessage => ({ id: r.id, client_msg_id: r.client_msg_id, from: r.from_agent, to: r.to_agent, type: r.type, body: JSON.parse(r.body), topic: r.topic, created_at: r.created_at })
```

（`Errors.gone` 与 Task 3 同一新增。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && npx vitest run test/group-send.test.ts && npx vitest run`
Expected: PASS 8/8 + 全量绿

- [ ] **Step 5: Commit**

```bash
git add server/src/core/group-send.ts server/test/group-send.test.ts
git commit -m "feat(server): sendGroupMessage — 事务 fanout + 封皮 + 精确前缀幂等 + file 群分支"
```

### Task 5: REST 路由（groups 端点 + messages 拦截）

**Files:**
- Create: `server/src/http/routes/groups.ts`
- Modify: `server/src/http/app.ts`（注册新路由，参照 `registerSendRoutes` 同款 deps）
- Modify: `server/src/http/routes/send.ts`（`to` 为群 → 拦截转发）
- Modify: `server/src/core/messages.ts:10`（`COLS` 追加 `group_id`——inbox/history/receipts 响应带群标记，M2 本地归档依赖，r1-Minor2）
- Modify: `server/test/helpers/ws-server.ts`（**r1-C2 必改**：①`mk` 幂等缓存；②`migrate(db, { defaultOwner: cfg.defaultOwner ?? undefined })`；③migrate 后 `alignRoles(db, cfg.humanIds)`——否则所有 human 角色断言在本文件与 Task 6/7 全挂，生产路径 alignRoles 在 index.ts 不覆盖测试）
- Test: `server/test/groups-routes.test.ts`

**Interfaces:**
- Consumes: Task 3 groups core 全部；Task 4 `sendGroupMessage`；`getAuth`/`authenticate`；`getAgent`
- Produces: REST 面
  - `POST /v1/groups` `{name, members}` → 201 `{id}`
  - `GET /v1/groups` → 我可见的群
  - `PATCH /v1/groups/:id` `{name}`；`POST /v1/groups/:id/members` `{agent_id}`；`DELETE /v1/groups/:id/members/:agentId`；`DELETE /v1/groups/:id`
  - `POST /v1/groups/:id/messages` → 201 fanout 结果
  - `GET /v1/groups/:id/messages?after=&limit=` → 时间线（可见性校验）
  - `POST /v1/messages` to=`role:'group'` → 转发 sendGroupMessage，返回同形结果
- Produces: **human 角色守卫** `requireHuman(req)`：`getAuth(req).agent.role !== 'human'` → 403（groups 管理端点全用它；`:id/messages` 不用——成员 agent 可发）

- [ ] **Step 1: 写失败测试**

```ts
// server/test/groups-routes.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startWsServer } from './helpers/ws-server.js'

let srv: Awaited<ReturnType<typeof startWsServer>>
let token = (id: string) => 'Bearer ' + srv.mk(id).token

beforeAll(async () => { srv = await startWsServer({ AGENTLINK_HUMAN_IDS: 'kt.human,zhy.human' }) })
afterAll(async () => { await srv.close() })

describe('groups REST', () => {
  it('human 建群/群发/时间线；agent 不能建群（403）；非可见 human 403', async () => {
    srv.mk('kt.human'); srv.mk('zhy.human'); srv.mk('kt.a1'); srv.mk('kt.a2'); srv.mk('stranger.human'); srv.mk('other.agent')
    const g = await srv.app.inject({ method: 'POST', url: '/v1/groups', headers: { authorization: token('kt.human') }, payload: { name: '作战室', members: ['kt.a1', 'kt.a2'] } })
    expect(g.statusCode).toBe(201); const gid = g.json().id
    expect((await srv.app.inject({ method: 'POST', url: '/v1/groups', headers: { authorization: token('kt.a1') }, payload: { name: 'x', members: ['kt.a1'] } })).statusCode).toBe(403)
    const send = await srv.app.inject({ method: 'POST', url: `/v1/groups/${gid}/messages`, headers: { authorization: token('kt.human') }, payload: { type: 'text', body: { text: '开会' }, client_msg_id: 'c1' } })
    expect(send.statusCode).toBe(201); expect(send.json().delivered).toBe(3) // owner+a1+a2（r1-M2：建群者入 members）
    const tl = await srv.app.inject({ method: 'GET', url: `/v1/groups/${gid}/messages?limit=10`, headers: { authorization: token('kt.human') } })
    expect(tl.json()).toHaveLength(3)
    expect((await srv.app.inject({ method: 'GET', url: `/v1/groups/${gid}/messages`, headers: { authorization: token('stranger.human') } })).statusCode).toBe(403) // 注：stranger.human 不在 HUMAN_IDS → role='agent'，以 agent 身份 403（非成员），断言同成立
  })
  it('POST /v1/messages to=grp.* 拦截：与 groups 端点行为一致（fanout 而非单行）；限流按 1 条', async () => {
    const g = await srv.app.inject({ method: 'POST', url: '/v1/groups', headers: { authorization: token('kt.human') }, payload: { name: 'g2', members: ['kt.a1', 'kt.a2'] } })
    const gid = g.json().id
    const r = await srv.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: token('kt.human') }, payload: { to: gid, type: 'text', body: { text: 'via im send' }, client_msg_id: 'c2' } })
    expect(r.statusCode).toBe(201); expect(r.json().delivered).toBe(3)   // owner+a1+a2，不是单行 message
    expect(r.json().group_id).toBe(gid)
    // 非成员 agent 走旧端点 → 403
    expect((await srv.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: token('other.agent') }, payload: { to: gid, type: 'text', body: { text: 'x' }, client_msg_id: 'c3' } })).statusCode).toBe(403)
    // 普通 DM 不受影响
    expect((await srv.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: token('kt.a1') }, payload: { to: 'kt.a2', type: 'text', body: { text: 'dm' }, client_msg_id: 'c4' } })).statusCode).toBe(201)
  })
  it('改名/拉人/移人/解散 410：REST 权限分叉与 410 语义', async () => {
    const g = await srv.app.inject({ method: 'POST', url: '/v1/groups', headers: { authorization: token('kt.human') }, payload: { name: 'g3', members: ['kt.a1'] } })
    const gid = g.json().id
    expect((await srv.app.inject({ method: 'PATCH', url: `/v1/groups/${gid}`, headers: { authorization: token('zhy.human') }, payload: { name: 'x' } })).statusCode).toBe(403)
    expect((await srv.app.inject({ method: 'POST', url: `/v1/groups/${gid}/members`, headers: { authorization: token('kt.human') }, payload: { agent_id: 'kt.a2' } })).statusCode).toBe(204)
    expect((await srv.app.inject({ method: 'DELETE', url: `/v1/groups/${gid}/members/kt.a2`, headers: { authorization: token('zhy.human') } })).statusCode).toBe(403)
    expect((await srv.app.inject({ method: 'DELETE', url: `/v1/groups/${gid}`, headers: { authorization: token('kt.human') } })).statusCode).toBe(204)
    expect((await srv.app.inject({ method: 'POST', url: `/v1/groups/${gid}/messages`, headers: { authorization: token('kt.human') }, payload: { type: 'text', body: { text: 'x' }, client_msg_id: 'c5' } })).statusCode).toBe(410)
    expect((await srv.app.inject({ method: 'POST', url: `/v1/groups/${gid}/members`, headers: { authorization: token('kt.human') }, payload: { agent_id: 'kt.a2' } })).statusCode).toBe(410) // r2-Minor3：解散后拉人也 410
  })
})
```

（`startWsServer` helper 本 task 三改，缺一不可（r1-C2）：
1. **mk 幂等缓存**：同一 id 二次 register 会 400，且 token 只显一次无法 try/catch 重取——`const made = new Map(); mk = id => made.get(id) ?? made.set(id, registerAgent(...)).get(id)`；
2. `migrate(db)` → `migrate(db, { defaultOwner: cfg.defaultOwner ?? undefined })`；
3. migrate 后调 `alignRoles(db, cfg.humanIds)`——生产路径的 alignRoles 挂在 index.ts 启动，不覆盖走 helper 的测试；不接线则 `kt.human` role 停留 `'agent'`，requireHuman 403、visibleTo human 分支全 false，本文件与 Task 6/7 的 human 断言全挂。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run test/groups-routes.test.ts`
Expected: FAIL（404 route not found）

- [ ] **Step 3: 实现 routes/groups.ts + send.ts 拦截**

`routes/groups.ts`（骨架全量）：

```ts
import type { FastifyInstance } from 'fastify'
import { authenticate, getAuth } from '../auth.js'
import { getAgent } from '../../core/agents.js'
import { Errors } from '../errors.js'
import { createGroup, listGroupsFor, renameGroup, addMember, removeMember, dissolveGroup, visibleTo, groupTimeline } from '../../core/groups.js'
import { sendGroupMessage } from '../../core/group-send.js'
import type { Db } from '../../db/sqlite.js'; import type { Config } from '../../config.js'
import type { Bus } from '../../core/bus.js'; import type { RateLimiter } from '../../core/ratelimit.js'

export function registerGroupRoutes(app: FastifyInstance, deps: { db: Db; cfg: Config; bus: Bus; limiter: RateLimiter }): void {
  const auth = authenticate(deps.db, deps.cfg)
  const requireHuman = (req: any) => { if (getAuth(req).agent.role !== 'human') throw Errors.forbidden('human only') }

  app.post('/v1/groups', { preHandler: auth }, async (req, reply) => {
    requireHuman(req)
    const me = getAuth(req).agent.id
    const { id } = createGroup(deps.db, me, req.body as { name: string; members: string[] })
    return reply.status(201).send({ id })
  })
  app.get('/v1/groups', { preHandler: auth }, async (req) => {
    requireHuman(req)
    return { groups: listGroupsFor(deps.db, getAuth(req).agent.id) }
  })
  app.patch('/v1/groups/:id', { preHandler: auth }, async (req, reply) => {
    requireHuman(req); renameGroup(deps.db, getAuth(req).agent.id, (req.params as any).id, (req.body as any).name); return reply.status(204).send()
  })
  app.post('/v1/groups/:id/members', { preHandler: auth }, async (req, reply) => {
    requireHuman(req); addMember(deps.db, getAuth(req).agent.id, (req.params as any).id, (req.body as any).agent_id); return reply.status(204).send()
  })
  app.delete('/v1/groups/:id/members/:agentId', { preHandler: auth }, async (req, reply) => {
    requireHuman(req); const p = req.params as any; removeMember(deps.db, getAuth(req).agent.id, p.id, p.agentId); return reply.status(204).send()
  })
  app.delete('/v1/groups/:id', { preHandler: auth }, async (req, reply) => {
    requireHuman(req); dissolveGroup(deps.db, getAuth(req).agent.id, (req.params as any).id); return reply.status(204).send()
  })
  app.post('/v1/groups/:id/messages', { preHandler: auth }, async (req, reply) => {
    const me = getAuth(req).agent.id
    deps.limiter.checkMessage(me) // 群发按 1 条预算（spec §6）
    const out = sendGroupMessage(deps.db, deps.bus, me, { ...(req.body as any), to: (req.params as any).id }) // to 在后兜底：body 里的 to 不可覆盖路径参数（r1-Minor1）
    return reply.status(out.deduplicated ? 200 : 201).send(out)
  })
  app.get('/v1/groups/:id/messages', { preHandler: auth }, async (req) => {
    const me = getAuth(req).agent.id; const id = (req.params as any).id
    if (!visibleTo(deps.db, id, me)) throw Errors.forbidden('group not visible')
    const q = req.query as any
    return groupTimeline(deps.db, id, { after: q.after, limit: Math.min(Number(q.limit) || 50, 200) })
  })
}
```

`send.ts`：`getAgent(deps.db, input.to)` 之后插：

```ts
    const recipient = getAgent(deps.db, input.to) // 404 if unknown
    if (recipient.role === 'group') {
      // r1-M4：im send 实际入径——群 id 不直插单行，与 groups 端点共用 fanout
      const out = sendGroupMessage(deps.db, deps.bus, me, { to: input.to, type: input.type, body: input.body as never, client_msg_id: input.client_msg_id })
      return reply.status(out.deduplicated ? 200 : 201).send(out)
    }
```

（原 `getAgent(deps.db, input.to)` 行改为接收返回值；import `sendGroupMessage`。）

`app.ts`：import + `registerGroupRoutes(app, { db: deps.db, cfg: deps.cfg, bus: deps.bus, limiter })`（紧随 registerSendRoutes）。

helper `ws-server.ts` 的 `mk` 改缓存版（见 Step 1 括注）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && npx vitest run test/groups-routes.test.ts && npx vitest run`
Expected: PASS 3/3 + 全量绿（send 旧测试不受影响——DM 路径原样）

- [ ] **Step 5: Commit**

```bash
git add server/src/http/routes/groups.ts server/src/http/routes/send.ts server/src/http/app.ts server/src/core/messages.ts server/test/helpers/ws-server.ts server/test/groups-routes.test.ts
git commit -m "feat(server): /v1/groups* 路由 + POST /v1/messages 群拦截（双入口共用 fanout）"
```

### Task 6: WS 拒绝 + file 群下载 + 目录过滤 + /v1/me role

**Files:**
- Modify: `server/src/ws/hub.ts`（send op 群拒绝，`recipient` 已在手只需判 role）
- Modify: `server/src/core/files.ts`（`getFile` 授权加群成员判定）
- Modify: `server/src/core/agents.ts`（`searchAgents` 滤 role='group'）
- Modify: `server/src/http/routes/agents.ts:38`（/v1/me 返回体 agent 自带 role/owner——rowToAgent 已含，确认透传即可；presence 不变）
- Test: `server/test/group-guards.test.ts`

**Interfaces:**
- Consumes: Task 1-5
- Produces: WS `send` to 群 → `{op:'error', code:'INVALID_REQUEST', message:'group messages must go through REST (im send)'}`；`getFile(db, requester, id)` 对 `to_agent` 为群且 requester ∈ group_members 放行；目录默认不列 `role='group'`（`?all=1` 列出）

- [ ] **Step 1: 写失败测试**

```ts
// server/test/group-guards.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { openDb, migrate } from '../src/db/sqlite.js'
import { loadConfig } from '../src/config.js'
import { registerAgent, alignRoles, searchAgents } from '../src/core/agents.js'
import { createGroup } from '../src/core/groups.js'
import { getFile } from '../src/core/files.js'
import { startWsServer } from './helpers/ws-server.js'
import WebSocket from 'ws'

describe('group guards', () => {
  it('WS send to=grp.* → error INVALID_REQUEST，不落库', async () => {
    const srv = await startWsServer({ AGENTLINK_HUMAN_IDS: 'kt.human' })
    try {
      srv.mk('kt.human'); srv.mk('kt.a1'); srv.mk('kt.a2')
      const gid = createGroup(srv.db, 'kt.human', { name: 'g', members: ['kt.a1', 'kt.a2'] }).id
      const ws = new WebSocket(srv.url)
      const frames: any[] = []; ws.on('message', d => frames.push(JSON.parse(String(d))))
      await new Promise(r => ws.on('open', r))
      ws.send(JSON.stringify({ op: 'auth', token: srv.mk('kt.a1').token }))
      await new Promise(r => setTimeout(r, 300))
      ws.send(JSON.stringify({ op: 'send', to: gid, body: { text: '黑洞?' }, client_msg_id: 'w1' }))
      await new Promise(r => setTimeout(r, 300))
      const err = frames.find(f => f.op === 'error')
      expect(err?.code).toBe('INVALID_REQUEST')
      expect((srv.db.prepare('SELECT COUNT(*) c FROM messages WHERE group_id=?').get(gid) as any).c).toBe(0)
      ws.close()
    } finally { await srv.close() }
  })
  it('getFile：群成员（非发送者）可取回 to=grp 的 file；非成员不可', () => {
    const cfg = loadConfig({ REGISTRATION_CODE: 'x', PORT: '0', AGENTLINK_HUMAN_IDS: 'kt.human' } as never)
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'fg-')), 't.db')); migrate(db)
    const mk = (id: string) => registerAgent(db, cfg, { agent_id: id, registration_code: 'x' })
    mk('kt.human'); mk('kt.a1'); mk('kt.a2'); mk('out.x'); alignRoles(db, cfg.humanIds)
    const gid = createGroup(db, 'kt.human', { name: 'g', members: ['kt.a1', 'kt.a2'] }).id
    db.prepare(`INSERT INTO files (id, from_agent, to_agent, name, size, sha256, created_at, expires_at) VALUES ('file_G1', 'kt.a1', ?, 'f', 1, 'h', '2026-01-01T00:00:00Z', '2999-01-01T00:00:00Z')`).run(gid)
    expect(getFile(db, 'kt.a2', 'file_G1')?.id).toBe('file_G1')  // 成员
    expect(getFile(db, 'kt.human', 'file_G1')?.id).toBe('file_G1') // 建群者（owner 视角可见）
    expect(getFile(db, 'out.x', 'file_G1')).toBeUndefined()        // 非成员按不存在处理
  })
  it('目录默认滤 role=group；?all 列出（searchAgents 加参）', () => {
    const cfg = loadConfig({ REGISTRATION_CODE: 'x', PORT: '0' } as never)
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'dg-')), 't.db')); migrate(db)
    registerAgent(db, cfg, { agent_id: 'plain.a', registration_code: 'x' })
    registerAgent(db, cfg, { agent_id: 'kt.human', registration_code: 'x' })
    // 直插伪 agent（createGroup 校验 members ≥1，目录过滤测试不需要完整群）
    const gid = 'grp.deadbeef'
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO agents (id, display_name, description, capabilities, task_policy, created_at, last_seen_at, role, owner) VALUES (?, 'g', '', '[]', '{}', ?, ?, 'group', 'kt.human')`).run(gid, now, now)
    db.prepare('INSERT INTO groups (id, owner, created_at) VALUES (?,?,?)').run(gid, 'kt.human', now)
    const defaultIds = searchAgents(db, {}, new Set(), 60_000).map(a => a.id)
    expect(defaultIds).not.toContain(gid)
    expect(defaultIds).toContain('plain.a')
    const allIds = searchAgents(db, { all: true } as any, new Set(), 60_000).map(a => a.id)
    expect(allIds).toContain(gid)
  })
})
```

（`searchAgents` 签名加 `q.all`，见 Step 3。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run test/group-guards.test.ts`
Expected: FAIL（WS 现在会 sent 成功落库 / getFile 拒成员 / 目录含群）

- [ ] **Step 3: 实现**

`hub.ts` send 分支：`if (!recipient)` 检查后加

```ts
        if ((recipient as any).role === 'group')
          return s.socket.send(JSON.stringify({ op: 'error', code: 'INVALID_REQUEST', message: 'group messages must go through REST (im send)' })) // r1-M2 防绕过 fanout 黑洞
```

（`recipient` 变量已存在，Agent 类型已带 role。）

`files.ts getFile`：

```ts
export function getFile(db: Db, requester: string, id: string): FileRow | undefined {
  const r = db.prepare('SELECT * FROM files WHERE id=?').get(id) as FileRow | undefined
  if (!r) return undefined
  if (r.from_agent === requester || r.to_agent === requester) return r
  // 群文件（r1-M1）：to=群 且 requester 是群成员 → 放行；否则按不存在处理（防枚举）
  if (r.to_agent.startsWith('grp.')) {
    const member = db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND agent_id=?').get(r.to_agent, requester)
    if (member) return r
    const owner = db.prepare('SELECT owner FROM groups WHERE id=?').get(r.to_agent) as { owner: string } | undefined
    if (owner?.owner === requester) return r // 建群者
  }
  return undefined
}
```

`agents.ts searchAgents`：签名加 `all?: boolean`（q 对象解构处）；首行查询改：

```ts
  let out = (db.prepare(q.all ? `SELECT * FROM agents WHERE id != 'server' ORDER BY id` : `SELECT * FROM agents WHERE id != 'server' AND role != 'group' ORDER BY id`).all() as any[]).map(rowToAgent)
```

`routes/agents.ts` 目录路由把 `req.query` 透传给 `searchAgents`（现有透传则只改类型；`?all=1` 由 AJV/手动 `q.all === '1' || q.all === true` 判定——按现有 query 解析风格实现，字符串 `'1'` 视为 true）。`/v1/me` 无需改码：`rowToAgent` 已带 role/owner 且 `/v1/me` 返回整个 agent 对象——加一条断言测试即可（并在 `agent_notes` 未实现前 owner 字段可空串）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && npx vitest run test/group-guards.test.ts && npx vitest run`
Expected: PASS 3/3 + 全量绿（files 旧测试的授权语义不变：非群 file 走原路径）

- [ ] **Step 5: Commit**

```bash
git add server/src/ws/hub.ts server/src/core/files.ts server/src/core/agents.ts server/src/http/routes/agents.ts server/test/group-guards.test.ts
git commit -m "feat(server): WS 群黑洞拒绝 + 群文件成员下载 + 目录滤群伪 agent"
```

### Task 7: E2E 冒烟 + 文档

**Files:**
- Test: `server/test/group-e2e.test.ts`（REST 全链路，模拟 im send）
- Modify: `skills/agentlink/SKILL.md`（群聊段：`im send grp.xxx` 用法 + 封皮说明）

**Interfaces:**
- Consumes: 全部前置任务
- Produces: E2E 证明「成员侧零改动」：普通 agent 用现有 REST `/v1/messages` 发群消息、用现有 `getInbox`/`ackMessages` 收

- [ ] **Step 1: 写 E2E 测试**

```ts
// server/test/group-e2e.test.ts — 全链路：human 建群 → agent 群发 → 成员收件箱可见 + ack
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getInbox, ackMessages } from '../src/core/messages.js'
import { startWsServer } from './helpers/ws-server.js'

let srv: Awaited<ReturnType<typeof startWsServer>>
beforeAll(async () => { srv = await startWsServer({ AGENTLINK_HUMAN_IDS: 'kt.human' }) })
afterAll(async () => { await srv.close() })

describe('group e2e', () => {
  it('human 建群 → 成员 agent 经 POST /v1/messages 群发 → 双成员 inbox 各见 1 条 + 封皮 + ack', async () => {
    srv.mk('kt.human'); srv.mk('kt.a1'); srv.mk('kt.a2')
    const ht = srv.mk('kt.human').token
    const g = await srv.app.inject({ method: 'POST', url: '/v1/groups', headers: { authorization: `Bearer ${ht}` }, payload: { name: 'E2E 群', members: ['kt.a1', 'kt.a2'] } })
    const gid = g.json().id
    // 成员 agent 用现有 im send 路径（零新命令）
    const at = srv.mk('kt.a1').token
    const r = await srv.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${at}` }, payload: { to: gid, type: 'text', body: { text: '群发冒烟' }, client_msg_id: 'e2e-1' } })
    expect(r.statusCode).toBe(201); expect(r.json().delivered).toBe(3) // owner(kt.human)+a1+a2（r1-M2）
    for (const member of ['kt.a1', 'kt.a2']) {
      const inbox = getInbox(srv.db, member, 10)
      expect(inbox).toHaveLength(1)
      expect(inbox[0].body.group.name).toBe('E2E 群')
      expect(inbox[0].topic).toBe('g-' + gid.slice(4))
      expect(inbox[0].group_id).toBe(gid) // messages.ts COLS 已加 group_id（r1-Minor2）
      expect(ackMessages(srv.db, srv.bus, member, [inbox[0].id]).acked).toHaveLength(1)
    }
    // human 视角群时间线
    const tl = await srv.app.inject({ method: 'GET', url: `/v1/groups/${gid}/messages`, headers: { authorization: `Bearer ${ht}` } })
    expect(tl.json()).toHaveLength(3)
  })
})
```

- [ ] **Step 2: 跑测试确认失败→通过**

Run: `cd server && npx vitest run test/group-e2e.test.ts`
Expected: 首跑若前置任务全绿则直接 PASS（E2E 是整合证明）；若有失败按 systematic-debugging 修（不许改测试迁就实现）

- [ ] **Step 3: SKILL.md 文档段**

`skills/agentlink/SKILL.md` 消息收发段后加：

```markdown
### 群聊（group）

- 群 id 形如 `grp.ab12cd34`；`im send grp.ab12cd34 "..."` 即群发（与私聊同命令，服务端 fanout 给全部成员）
- 收到的群消息带封皮：`body.group = {id, name, members}`，topic 为 `g-<8hex>`
- 回复群请继续 `im send grp.xxx`；读群史 `im history --topic g-<8hex>`
- 群文件与私聊同用法（`im file` 上传时 `to=grp.xxx`），全体成员可 `im fetch`
```

- [ ] **Step 4: 全量回归 + Commit**

Run: `cd server && npx vitest run`
Expected: 全绿

```bash
git add server/test/group-e2e.test.ts skills/agentlink/SKILL.md
git commit -m "test+docs: 群聊 M1 E2E 冒烟 + SKILL.md 群聊用法"
```

---

## 部署注意（实现完成后、不属任务）

- 生产 env 需配 `AGENTLINK_HUMAN_IDS`、`AGENTLINK_REG_CODES`（或沿用 `REGISTRATION_CODE` + `AGENTLINK_DEFAULT_OWNER`）再重启 server（docker compose）
- zhy 的存量 agent 归属回填：迁移后部署层执行一条 UPDATE（spec §1.5，不属于本计划代码任务）
- M2（observe/所有权/本地归档）、M3（console）另立计划

## 已裁决的接受面（critic r1 Minors，随实现不再处理）

- **Minor4**：DM 的 cmid 字面量恰为 `abc:0` 时与同 sender 群发 cmid `abc` 前缀互撞误 dedup——cmid 实际为 UUID，记录不修。
- **Minor5**：`POST /v1/messages` 群拦截响应无 `topic_registered` 字段——已核 `im.mjs:287` 仅在 `=== false` 时打提示，缺字段不触发任何客户端分支，安全。
- **Minor7**：非成员可向 `to=grp.xxx` 预留上传（占自己配额、无法群发引用）——无害，接受；M2 若收紧在 reserveFile 加成员校验。
- **Minor8**：`listGroupsFor` 会列出已解散群（成员空）——M3 console 计划时裁决呈现方式（隐藏或标记）。
