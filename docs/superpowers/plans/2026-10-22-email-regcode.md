# Email Self-Service Registration Codes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 人类在落地页用邮箱自助申请注册码（邮箱验证码认证），`registerAgent` 认 DB 分码即归属该人类并授予 `role='human'`。

**Architecture:** 新表 `registration_codes`/`email_verifies`（schema v9）；core 层 `regcodes.ts`（apply/verify/status/revoke，邮件经注入的 transport 接口发送）；`registerAgent` 在 env 分码分支前插 DB 码分支，公开码与 `ALLOW_OPEN_REGISTRATION` 统一收口到同一 sticky 门；无鉴权 REST `/v1/regcode/*` + `x-admin-token` 吊销端点；前端 onboarding.html 运行时 fetch status 切换、落地页新增申请表单。

**Tech Stack:** TypeScript + Fastify 5 + better-sqlite3 + nodemailer（新依赖）+ vitest。

**Spec:** `docs/superpowers/specs/2026-10-22-email-regcode-design.md`（v5，critic r1-r4 收敛）

## Global Constraints

- 码格式 `al_reg_<24hex>`（`randomBytes(12).toString('hex')`）；验证码 6 位数字，sha256 入库，TTL 10min，≥5 次失败作废记录
- email 归一化：local 小写 + 去 `+tag`，domain 小写；**收件人用原始输入 email**
- apply **业务结果恒 204**（400 形状 / 429 限流 / 500 发信失败 / 503 SMTP 未配除外）；503 短路在写 `email_verifies` **之前**
- verify 占用复查在 `db.transaction()` **之前**，409 时零写副作用；发码三步（吊销旧码→写新码→DELETE 验证记录）单事务
- sticky 门：公开码回退与 `ALLOW_OPEN_REGISTRATION` 均要求「env 分码空 **且** DB `COUNT(*)=0`（含已吊销）」；status 优先级 code > open > closed
- 吊销端点鉴权 `x-admin-token`，恒 403（market.ts:75-77 先例），幂等 204
- audit：`regcode.applied|verified|issued|mail_failed|revoked`，actor 固定 `'regcode'`，邮箱脱敏 `sha256前12位@domain`
- 限流：apply 3/h/IP + 2/h/归一化邮箱；verify 10/h/IP；email 键惰性清理 cutoff ≥ 1h
- DB 码明文入库（刻意）；落地页所有动态回显一律 textContent，禁 innerHTML
- 测试跑法：`cd server && npx vitest run <file>`；全量 `npx vitest run`；类型 `npx tsc -p tsconfig.json --noEmit`

## Review Focus

1. **sticky 旁路**：env 分码清空 + DB 已发过码（全已吊销）+ `ALLOW_OPEN_REGISTRATION=true` → 仍须 403 闭门（agents.ts 现状 else 分支会放行）——Task 3 测试 `吊销后 ALLOW_OPEN 仍闭`
2. **apply 对既有码零副作用**：匿名者持他人邮箱 apply 多次，不吊销该邮箱已领未用的码——Task 2 测试 `apply 不动既有码`
3. **verify 409 零写副作用**：id 被抢注 → 409 且该邮箱旧码仍有效、验证记录仍在（可重试）——Task 2 测试 `verify 409 不动码与记录`
4. **限流键清理放大配额**：email 键 2/h 桶被 2 分钟清理误删 → 1h 内可超额——Task 5 测试 `email 桶 1h 内不清理`
5. **邮件死信不阻塞主流程**：verify 补发邮件失败仍 200 返回码（码以响应体为准）——Task 2 测试 `补发失败不影响发码`

---

### Task 1: schema v9 迁移 + audit 事件

**Files:**
- Modify: `server/src/db/schema.ts:248`（v8 门之后、server 行 INSERT 之前插 v9 门）
- Modify: `server/src/core/audit.ts:15`（AuditEvent union）
- Test: `server/test/migration-v9.test.ts`（新建）

**Interfaces:**
- Consumes: 既有 `user_version` 门控模式（schema.ts:69 起）
- Produces: 表 `registration_codes(code PK, owner_agent_id, email_norm, created_at, revoked_at)` + 索引 `idx_regcode_email`；表 `email_verifies(email_norm PK, secret_hash, human_agent_id, expires_at, attempts)`；AuditEvent 含 `regcode.applied | regcode.verified | regcode.issued | regcode.mail_failed | regcode.revoked`

- [ ] **Step 1: 写失败测试**

```ts
// server/test/migration-v9.test.ts —— v9 迁移：regcode 两表 + 版本门控幂等
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { openDb, migrate } from '../src/db/sqlite.js'

const fresh = () => { const db = openDb(join(mkdtempSync(join(tmpdir(), 'mv9-')), 't.db')); migrate(db); return db }

describe('migration v9', () => {
  it('建 registration_codes/email_verifies；user_version=9；重跑幂等', () => {
    const db = fresh()
    expect((db.prepare('PRAGMA user_version').get() as any).user_version).toBe(9)
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map(c => c.name)
    expect(cols('registration_codes')).toEqual(['code', 'owner_agent_id', 'email_norm', 'created_at', 'revoked_at'])
    expect(cols('email_verifies')).toEqual(['email_norm', 'secret_hash', 'human_agent_id', 'expires_at', 'attempts'])
    // r1 minor：索引与 PK 语义一并钉死（email_verifies PK 支撑 apply 覆盖语义）
    expect((db.prepare(`SELECT COUNT(*) c FROM pragma_index_list('registration_codes') WHERE name='idx_regcode_email'`).get() as any).c).toBe(1)
    db.prepare(`INSERT INTO email_verifies (email_norm, secret_hash, human_agent_id, expires_at, attempts) VALUES ('a@b.c', 'h1', 'kt.human', '2026-01-01T00:00:00Z', 0)`).run()
    db.prepare(`INSERT OR REPLACE INTO email_verifies (email_norm, secret_hash, human_agent_id, expires_at, attempts) VALUES ('a@b.c', 'h2', 'kt.human', '2026-01-02T00:00:00Z', 0)`).run() // 同邮箱覆盖（apply 覆盖语义的 PK 支撑）
    db.prepare(`INSERT INTO registration_codes (code, owner_agent_id, email_norm, created_at) VALUES ('al_reg_x', 'kt.human', 'a@b.c', '2026-01-01T00:00:00Z')`).run()
    migrate(db) // 幂等重跑不清数据
    expect((db.prepare(`SELECT COUNT(*) c FROM registration_codes`).get() as any).c).toBe(1)
  })
  it('v8 库升级路径：fresh 迁移含全部 v8 产物（group 列）——真实 v8→v9 老库升级由 user_version 门控保证，部署冒烟复核（r2-N6 注：fresh db 无法回停在 v8，此用例钉的是"v9 迁移不丢 v8 产物"）', () => {
    const db = fresh()
    expect((db.prepare(`SELECT COUNT(*) c FROM pragma_table_info('messages') WHERE name='group_id'`).get() as any).c).toBe(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run test/migration-v9.test.ts`
Expected: FAIL——`PRAGMA table_info(registration_codes)` 返回空 / user_version 为 8

- [ ] **Step 3: 实现**

`schema.ts` 在 `db.prepare('PRAGMA user_version = 8').run()` 所在 `if (v < 8)` 块之后插入（对齐既有门控风格）：

```ts
  // v9 迁移：邮箱自助注册码（spec 2026-10-22-email-regcode-design.md §2）
  if (v < 9) {
    db.transaction(() => {
      db.exec(`
      CREATE TABLE IF NOT EXISTS registration_codes (
        code TEXT PRIMARY KEY,
        owner_agent_id TEXT NOT NULL,
        email_norm TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_regcode_email ON registration_codes(email_norm);
      CREATE TABLE IF NOT EXISTS email_verifies (
        email_norm TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL,
        human_agent_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0
      );
      `)
      db.prepare('PRAGMA user_version = 9').run()
    })()
  }
```

`audit.ts` union 末行 `'file.…' | 'group.…'` 之后追加一行：

```ts
  | 'regcode.applied' | 'regcode.verified' | 'regcode.issued' | 'regcode.mail_failed' | 'regcode.revoked'
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && npx vitest run test/migration-v9.test.ts`
Expected: PASS 2/2。再跑 `npx vitest run test/schema-v8.test.ts test/migration-v2.test.ts` 确认旧迁移无回归。

- [ ] **Step 5: Commit**

```bash
git add server/src/db/schema.ts server/src/core/audit.ts server/test/migration-v9.test.ts
git commit -m "feat: schema v9 — registration_codes/email_verifies + regcode audit events"
```

---

### Task 2: core/regcodes.ts —— apply/verify/status/revoke

**Files:**
- Create: `server/src/core/regcodes.ts`
- Modify: `server/src/http/errors.ts`（加 `smtpNotConfigured` 503、`agentIdTaken` 409——`Errors.internal` 已存在直接复用）
- Test: `server/test/regcode-core.test.ts`（新建）

**Interfaces:**
- Consumes: `Db`（`../db/sqlite.js`）、`sha256Hex`（`./ids.js`）、`AGENT_ID_RE`（`./agents.js`）、`audit`、`Errors`
- Produces（Task 3/4/5 依赖，签名固定）:
  - `export interface MailTransport { sendMail(opts: { to: string; subject: string; text: string }): Promise<unknown> }`
  - `export function normalizeEmail(email: string): string | null`
  - `export function applyRegcode(db: Db, input: { email: string; human_agent_id: string }, transport: MailTransport | null): Promise<void>`（内部 audit；transport null → 503；发信失败 → 500）
  - `export function verifyRegcode(db: Db, input: { email: string; verify_code: string }, transport: MailTransport | null): Promise<{ registration_code: string }>`（错/过/超次 → 404；占用 → 409 `AGENT_ID_TAKEN`）
  - `export function regcodeStatus(db: Db, cfg: { regCodes: Map<string,string>; registrationCode: string | null; allowOpenRegistration: boolean }): 'closed' | 'code' | 'open'`
  - `export function revokeRegcode(db: Db, code: string): void`（幂等）
  - `export function revokeByOwner(db: Db, ownerAgentId: string): number`（返回吊销条数，0 亦合法）
  - `export function maskEmail(emailNorm: string): string`（`sha256前12位@domain`）

- [ ] **Step 1: 写失败测试**

```ts
// server/test/regcode-core.test.ts —— core 语义（spec §2/§4；SMTP 用 fake transport）
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { openDb, migrate } from '../src/db/sqlite.js'
import { normalizeEmail, applyRegcode, verifyRegcode, regcodeStatus, revokeRegcode, revokeByOwner, maskEmail, type MailTransport } from '../src/core/regcodes.js'

const setup = () => { const db = openDb(join(mkdtempSync(join(tmpdir(), 'rc-')), 't.db')); migrate(db); return db }
// fake transport：捕获发信；sent 数组元素 {to, text}；可注入失败
const fakeTransport = (fail = false): MailTransport & { sent: { to: string; text: string }[] } => {
  const sent: { to: string; text: string }[] = []
  return { sent, sendMail: async (o) => { if (fail) throw new Error('smtp down'); sent.push({ to: o.to, text: o.text }) } }
}
// 从 fake 发信正文里抠 6 位验证码
const codeFromMail = (t: { text: string }) => /\b(\d{6})\b/.exec(t.text)![1]

describe('normalizeEmail', () => {
  it('local 小写去 +tag，domain 小写；非法 null（domain 须含点——a@b 不可路由，判非法）', () => {
    expect(normalizeEmail('Foo+x@BAR.com')).toBe('foo@bar.com')
    expect(normalizeEmail('a@b')).toBeNull() // domain 无点 → null（r1-C3 定夺：拒收不可路由域）
    expect(normalizeEmail('nope')).toBeNull()
  })
})

describe('applyRegcode', () => {
  it('写验证记录（sha256 6位码，10min TTL）+ 发信收件人用原始 email；同邮箱 re-apply 覆盖', async () => {
    const db = setup(); const t = fakeTransport()
    await applyRegcode(db, { email: 'Foo+x@BAR.com', human_agent_id: 'new.human' }, t)
    const row = db.prepare(`SELECT * FROM email_verifies WHERE email_norm='foo@bar.com'`).get() as any
    expect(row.human_agent_id).toBe('new.human'); expect(row.attempts).toBe(0)
    expect(row.secret_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(Date.parse(row.expires_at)).toBeGreaterThan(Date.now() + 9 * 60_000)
    expect(t.sent).toHaveLength(1); expect(t.sent[0].to).toBe('Foo+x@BAR.com') // 原始收件人
    await applyRegcode(db, { email: 'foo@BAR.com', human_agent_id: 'new.human' }, t) // 归一化同键 → 覆盖非新增
    expect((db.prepare(`SELECT COUNT(*) c FROM email_verifies`).get() as any).c).toBe(1)
  })
  it('形状错误 400（email / human_agent_id）；transport null → 503 且不写记录；形状 400 优先于 503（r1-C2）', async () => {
    const db = setup(); const t = fakeTransport()
    await expect(applyRegcode(db, { email: 'nope', human_agent_id: 'a.b' }, t)).rejects.toThrowError(/400|invalid/i)
    await expect(applyRegcode(db, { email: 'a@b.c', human_agent_id: 'X!' }, t)).rejects.toThrowError(/agent_id/)
    await expect(applyRegcode(db, { email: 'a@b.c', human_agent_id: 'a.b' }, null)).rejects.toThrowError(/503|smtp/i)
    await expect(applyRegcode(db, { email: 'nope', human_agent_id: 'a.b' }, null)).rejects.toThrowError(/400|invalid/i) // 形状非法+未配 SMTP → 400 不是 503
    expect((db.prepare(`SELECT COUNT(*) c FROM email_verifies`).get() as any).c).toBe(0) // 503 短路在写库前
  })
  it('发信失败 500 + audit mail_failed，不写记录留死行（r4-m4 同理不留半态）', async () => {
    const db = setup(); const t = fakeTransport(true)
    await expect(applyRegcode(db, { email: 'a@b.c', human_agent_id: 'a.b' }, t)).rejects.toThrowError(/500|mail/i)
    expect((db.prepare(`SELECT COUNT(*) c FROM email_verifies`).get() as any).c).toBe(0)
    expect((db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE event='regcode.mail_failed'`).get() as any).c).toBe(1)
  })
  it('apply 不动既有注册码（r2-N1：匿名者反复 apply 不能吊销已领未用的码）', async () => {
    const db = setup(); const t = fakeTransport()
    await applyRegcode(db, { email: 'a@b.c', human_agent_id: 'h1' }, t)
    db.prepare(`INSERT INTO registration_codes (code, owner_agent_id, email_norm, created_at) VALUES ('al_reg_a', 'h1', 'a@b.c', '2026-01-01T00:00:00Z')`).run()
    await applyRegcode(db, { email: 'a@b.c', human_agent_id: 'h1' }, t); await applyRegcode(db, { email: 'a@b.c', human_agent_id: 'h1' }, t)
    expect((db.prepare(`SELECT revoked_at FROM registration_codes WHERE code='al_reg_a'`).get() as any).revoked_at).toBeNull()
  })
})

describe('verifyRegcode', () => {
  const prep = async (db: ReturnType<typeof setup>, email = 'a@b.c', id = 'new.human') => {
    const t = fakeTransport()
    await applyRegcode(db, { email, human_agent_id: id }, t)
    return codeFromMail(t.sent[0])
  }
  it('成功：吊销同邮箱旧码→写新码→删记录，单事务；码格式 al_reg_<24hex>；补发邮件收件人=原始 email', async () => {
    const db = setup()
    db.prepare(`INSERT INTO registration_codes (code, owner_agent_id, email_norm, created_at) VALUES ('al_reg_old', 'new.human', 'a@b.c', '2026-01-01T00:00:00Z')`).run()
    const vc = await prep(db, 'Foo@Bar.com')
    const t2 = fakeTransport()
    const out = await verifyRegcode(db, { email: 'Foo@Bar.com', verify_code: vc }, t2) // r3-P1：传原始大小写——顺带钉住"verify 收件人用原始输入"语义（码查询走归一化）
    expect(out.registration_code).toMatch(/^al_reg_[0-9a-f]{24}$/)
    const row = db.prepare(`SELECT * FROM registration_codes WHERE code=?`).get(out.registration_code) as any
    expect(row.owner_agent_id).toBe('new.human'); expect(row.email_norm).toBe('foo@bar.com'); expect(row.revoked_at).toBeNull()
    expect((db.prepare(`SELECT revoked_at FROM registration_codes WHERE code='al_reg_old'`).get() as any).revoked_at).not.toBeNull() // 旧码吊销
    expect((db.prepare(`SELECT COUNT(*) c FROM email_verifies`).get() as any).c).toBe(0) // 记录已删（一次性防重放）
    expect(t2.sent[0].to).toBe('Foo@Bar.com'); expect(t2.sent[0].text).toContain(out.registration_code)
    expect((db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE event='regcode.issued'`).get() as any).c).toBe(1)
    expect((db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE event='regcode.verified'`).get() as any).c).toBe(1) // r4-M3：正向断言（409 路径已有负向断言）
  })
  it('补发邮件失败不影响发码（200 语义，码以返回值为准）', async () => {
    const db = setup(); const vc = await prep(db)
    const out = await verifyRegcode(db, { email: 'a@b.c', verify_code: vc }, fakeTransport(true))
    expect(out.registration_code).toMatch(/^al_reg_/)
    expect((db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE event='regcode.mail_failed'`).get() as any).c).toBe(1)
  })
  it('错码 attempts+1；≥5 次作废（再验 404）；重放已用验证码 404；过期 404', async () => {
    const db = setup(); const vc = await prep(db)
    for (let i = 0; i < 4; i++) await expect(verifyRegcode(db, { email: 'a@b.c', verify_code: '000000' }, fakeTransport())).rejects.toThrowError(/404|not found/i)
    expect((db.prepare(`SELECT attempts FROM email_verifies WHERE email_norm='a@b.c'`).get() as any).attempts).toBe(4)
    const out = await verifyRegcode(db, { email: 'a@b.c', verify_code: vc }, fakeTransport()) // 第 5 次用对码仍可过
    expect(out.registration_code).toMatch(/^al_reg_/)
    await expect(verifyRegcode(db, { email: 'a@b.c', verify_code: vc }, fakeTransport())).rejects.toThrowError(/404|not found/i) // 重放 404
    // ≥5 次失败作废分支（r2-N4）：第 5 次失败删记录，随后正确码也 404（须重新 apply）
    const t5 = fakeTransport(); await applyRegcode(db, { email: 'bad5@x.y', human_agent_id: 'h5.human' }, t5)
    const vc5 = codeFromMail(t5.sent[0])
    for (let i = 0; i < 5; i++) await expect(verifyRegcode(db, { email: 'bad5@x.y', verify_code: '000000' }, fakeTransport())).rejects.toThrowError(/404|not found/i)
    await expect(verifyRegcode(db, { email: 'bad5@x.y', verify_code: vc5 }, fakeTransport())).rejects.toThrowError(/404|not found/i) // 记录已作废
    // 过期
    const t = fakeTransport(); await applyRegcode(db, { email: 'x@y.z', human_agent_id: 'h' }, t)
    db.prepare(`UPDATE email_verifies SET expires_at='2020-01-01T00:00:00Z' WHERE email_norm='x@y.z'`).run()
    await expect(verifyRegcode(db, { email: 'x@y.z', verify_code: codeFromMail(t.sent[0]) }, fakeTransport())).rejects.toThrowError(/404|not found/i)
  })
  it('占用复查 409 且零写副作用：旧码不被吊销、验证记录保留（r4-m2）', async () => {
    const db = setup()
    db.prepare(`INSERT INTO agents (id, display_name, description, capabilities, task_policy, created_at, last_seen_at) VALUES ('taken.id', 'x', '', '[]', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run()
    db.prepare(`INSERT INTO registration_codes (code, owner_agent_id, email_norm, created_at) VALUES ('al_reg_old', 'taken.id', 'a@b.c', '2026-01-01T00:00:00Z')`).run()
    const t = fakeTransport(); await applyRegcode(db, { email: 'a@b.c', human_agent_id: 'taken.id' }, t)
    await expect(verifyRegcode(db, { email: 'a@b.c', verify_code: codeFromMail(t.sent[0]) }, fakeTransport())).rejects.toMatchObject({ status: 409, code: 'AGENT_ID_TAKEN' })
    expect((db.prepare(`SELECT revoked_at FROM registration_codes WHERE code='al_reg_old'`).get() as any).revoked_at).toBeNull()
    expect((db.prepare(`SELECT COUNT(*) c FROM email_verifies WHERE email_norm='a@b.c'`).get() as any).c).toBe(1)
    expect((db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE event='regcode.verified'`).get() as any).c).toBe(0) // 409 零写副作用含 audit（verified 移到 409 之后）
  })
  it("human_agent_id='server'（系统预置行）→ 409 兜底", async () => {
    const db = setup(); const t = fakeTransport()
    await applyRegcode(db, { email: 'a@b.c', human_agent_id: 'server' }, t)
    await expect(verifyRegcode(db, { email: 'a@b.c', verify_code: codeFromMail(t.sent[0]) }, fakeTransport())).rejects.toMatchObject({ status: 409, code: 'AGENT_ID_TAKEN' })
  })
})

describe('regcodeStatus / revoke / maskEmail', () => {
  const cfg = (over: Partial<{ regCodes: Map<string,string>; registrationCode: string | null; allowOpenRegistration: boolean }> = {}) =>
    ({ regCodes: new Map(), registrationCode: null as string | null, allowOpenRegistration: false, ...over })
  it('三态 + 优先级 + sticky（含已吊销）', () => {
    const db = setup()
    expect(regcodeStatus(db, cfg({ registrationCode: 'pub' }))).toBe('open') // 从未发过码 → 公开码回退
    expect(regcodeStatus(db, cfg({ allowOpenRegistration: true }))).toBe('open')
    expect(regcodeStatus(db, cfg())).toBe('closed')
    db.prepare(`INSERT INTO registration_codes (code, owner_agent_id, email_norm, created_at) VALUES ('al_reg_1', 'h', 'a@b.c', '2026-01-01T00:00:00Z')`).run()
    expect(regcodeStatus(db, cfg({ registrationCode: 'pub', allowOpenRegistration: true }))).toBe('code') // 优先级 code > open（未吊销码>0）
    db.prepare(`UPDATE registration_codes SET revoked_at='2026-01-02T00:00:00Z' WHERE code='al_reg_1'`).run() // r1-C4：吊销后再验 sticky
    expect(regcodeStatus(db, cfg({ registrationCode: 'pub' }))).toBe('closed') // sticky：发过码（含已吊销）公开码永停
    expect(regcodeStatus(db, cfg({ registrationCode: 'pub', allowOpenRegistration: true }))).toBe('closed') // sticky 同样关 ALLOW_OPEN（§3.4）
    expect(regcodeStatus(db, cfg({ regCodes: new Map([['c', 'owner']]) }))).toBe('code') // env 分码 → code
  })
  it('吊销：幂等 204 语义；revokeByOwner 吊销名下全部、0 条亦合法；audit 仅记实际变更（r1-M2）', () => {
    const db = setup()
    db.prepare(`INSERT INTO registration_codes (code, owner_agent_id, email_norm, created_at) VALUES ('al_reg_1','h1','a@b.c','2026-01-01T00:00:00Z'), ('al_reg_2','h1','x@y.z','2026-01-01T00:00:00Z')`).run()
    revokeRegcode(db, 'al_reg_1')
    revokeRegcode(db, 'al_reg_1') // 幂等（二次调用 0 changes → 不重复 audit）
    expect((db.prepare(`SELECT COUNT(*) c FROM registration_codes WHERE revoked_at IS NULL`).get() as any).c).toBe(1)
    expect(revokeByOwner(db, 'h1')).toBe(1)
    expect(revokeByOwner(db, 'nobody')).toBe(0)
    expect((db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE event='regcode.revoked'`).get() as any).c).toBe(2) // 1（吊销 al_reg_1）+ 1（by-owner h1）
    expect(maskEmail('foo@bar.com')).toMatch(/^[0-9a-f]{12}@bar\.com$/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run test/regcode-core.test.ts`
Expected: FAIL——`Cannot find module '../src/core/regcodes.js'`

- [ ] **Step 3: 实现**

`server/src/http/errors.ts` 的 `Errors` 对象中加一行（对齐既有工厂风格）：

```ts
  smtpNotConfigured: () => new AppError('SMTP_NOT_CONFIGURED', 503, 'self-service regcode disabled: SMTP not configured'),
  agentIdTaken: () => new AppError('AGENT_ID_TAKEN', 409, 'human_agent_id already taken'), // r1-C1：verify 占用复查须 409，非 400
```

新建 `server/src/core/regcodes.ts`：

```ts
// 邮箱自助注册码 core（spec 2026-10-22-email-regcode-design.md §2/§3/§4，r1-r4 收敛）
// apply 零占用提示（防枚举）；verify 占用复查在事务外（409 零副作用）；sticky 门含已吊销
import { randomBytes, randomInt } from 'node:crypto'
import type { Db } from '../db/sqlite.js'
import { Errors } from '../http/errors.js'
import { sha256Hex } from './ids.js'
import { audit } from './audit.js'
import { AGENT_ID_RE } from './agents.js'

export interface MailTransport { sendMail(opts: { to: string; subject: string; text: string }): Promise<unknown> }

export function normalizeEmail(email: string): string | null {
  const m = /^([^@]+)@([^@]+)$/.exec((email ?? '').trim())
  if (!m || !m[2].includes('.')) return null
  return `${m[1].toLowerCase().replace(/\+.*$/, '')}@${m[2].toLowerCase()}`
}

export const maskEmail = (emailNorm: string): string => sha256Hex(emailNorm).slice(0, 12) + '@' + emailNorm.split('@')[1]
const aud = (db: Db, event: 'regcode.applied' | 'regcode.verified' | 'regcode.issued' | 'regcode.mail_failed' | 'regcode.revoked', detail: Record<string, unknown>) =>
  audit(db, 'regcode', event, detail) // actor 固定 'regcode'（r4-m6）；邮箱一律 maskEmail 后入 detail

const newRegCode = (): string => 'al_reg_' + randomBytes(12).toString('hex')

export async function applyRegcode(db: Db, input: { email: string; human_agent_id: string }, transport: MailTransport | null): Promise<void> {
  // r1-C2：形状校验先行——形状非法时即使 SMTP 未配也回 400（信息更准），503 不得吞 400
  const norm = normalizeEmail(input.email)
  if (!norm) throw Errors.invalidRequest('email invalid')
  if (!AGENT_ID_RE.test(input.human_agent_id ?? '')) throw Errors.invalidRequest('human_agent_id must match ^[a-z0-9][a-z0-9.-]{2,31}$')
  if (!transport) throw Errors.smtpNotConfigured() // 503 短路仍在写库之前（r4-m4）
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const expires = new Date(Date.now() + 10 * 60_000).toISOString()
  try {
    await transport.sendMail({ to: input.email.trim(), subject: 'AgentLink 注册验证码', text: `你的验证码是 ${code}，10 分钟内有效。用它确认申请注册码，注册码将归属 ${input.human_agent_id}。` })
  } catch (e) {
    aud(db, 'regcode.mail_failed', { stage: 'apply', email: maskEmail(norm) })
    throw Errors.internal('mail send failed')
  }
  db.prepare(`INSERT INTO email_verifies (email_norm, secret_hash, human_agent_id, expires_at, attempts) VALUES (?,?,?,?,0)
    ON CONFLICT(email_norm) DO UPDATE SET secret_hash=excluded.secret_hash, human_agent_id=excluded.human_agent_id, expires_at=excluded.expires_at, attempts=0`)
    .run(norm, sha256Hex(code), input.human_agent_id, expires)
  aud(db, 'regcode.applied', { email: maskEmail(norm), human_agent_id: input.human_agent_id })
}

export async function verifyRegcode(db: Db, input: { email: string; verify_code: string }, transport: MailTransport | null): Promise<{ registration_code: string }> {
  const norm = normalizeEmail(input.email)
  const row = norm ? db.prepare('SELECT * FROM email_verifies WHERE email_norm=?').get(norm) as { secret_hash: string; human_agent_id: string; expires_at: string; attempts: number } | undefined : undefined
  const gone = () => Errors.notFound('verify record not found / expired')
  if (!row || Date.parse(row.expires_at) <= Date.now()) throw gone()
  if (sha256Hex(input.verify_code ?? '') !== row.secret_hash) {
    if (row.attempts + 1 >= 5) db.prepare('DELETE FROM email_verifies WHERE email_norm=?').run(norm!)
    else db.prepare('UPDATE email_verifies SET attempts=attempts+1 WHERE email_norm=?').run(norm!)
    throw gone()
  }
  // 占用复查在事务外（r4-m2）：409 时零写副作用（含 audit——verified 事件移到 409 之后，r1 minor）
  if (db.prepare('SELECT 1 FROM agents WHERE id=?').get(row.human_agent_id)) throw Errors.agentIdTaken()
  aud(db, 'regcode.verified', { email: maskEmail(norm!) })
  const code = newRegCode()
  const now = new Date().toISOString()
  db.transaction(() => {
    db.prepare('UPDATE registration_codes SET revoked_at=? WHERE email_norm=? AND revoked_at IS NULL').run(now, norm) // 一邮箱一有效码，发码时执行（r2-N1）
    db.prepare('INSERT INTO registration_codes (code, owner_agent_id, email_norm, created_at) VALUES (?,?,?,?)').run(code, row.human_agent_id, norm, now)
    db.prepare('DELETE FROM email_verifies WHERE email_norm=?').run(norm) // 一次性防重放（r1-I1）
  })()
  aud(db, 'regcode.issued', { email: maskEmail(norm!), human_agent_id: row.human_agent_id })
  if (transport) {
    try { await transport.sendMail({ to: input.email.trim(), subject: 'AgentLink 注册码', text: `你的注册码：${code}\nagent 注册命令：im register <agent_id> --code ${code}\n该码注册的 agent 将归属 ${row.human_agent_id}。` }) }
    catch { aud(db, 'regcode.mail_failed', { stage: 'issue', email: maskEmail(norm!) }) } // 补发失败不影响发码（r1-I2）
  }
  return { registration_code: code }
}

// 三态（§4，r4-M1 优先级 code > open > closed）；sticky 门 = env 分码空 且 DB 从未发过码（COUNT(*) 含已吊销）
export function regcodeStatus(db: Db, cfg: { regCodes: Map<string, string>; registrationCode: string | null; allowOpenRegistration: boolean }): 'closed' | 'code' | 'open' {
  const anyCode = (db.prepare('SELECT COUNT(*) c FROM registration_codes').get() as { c: number }).c
  const unrevoked = (db.prepare('SELECT COUNT(*) c FROM registration_codes WHERE revoked_at IS NULL').get() as { c: number }).c
  if (cfg.regCodes.size || unrevoked > 0) return 'code'
  if ((cfg.registrationCode || cfg.allowOpenRegistration) && anyCode === 0) return 'open'
  return 'closed'
}

export function revokeRegcode(db: Db, code: string): void {
  const r = db.prepare('UPDATE registration_codes SET revoked_at=? WHERE code=? AND revoked_at IS NULL').run(new Date().toISOString(), code)
  if (r.changes) aud(db, 'regcode.revoked', { code_prefix: code.slice(0, 12) }) // r1-M2：幂等重吊不重复 audit
}

export function revokeByOwner(db: Db, ownerAgentId: string): number {
  const r = db.prepare('UPDATE registration_codes SET revoked_at=? WHERE owner_agent_id=? AND revoked_at IS NULL').run(new Date().toISOString(), ownerAgentId)
  if (r.changes) aud(db, 'regcode.revoked', { owner_agent_id: ownerAgentId, count: r.changes })
  return r.changes
}
```

注意：`Errors.internal` 已存在于 errors.ts（`internal: (m = 'internal error') => new AppError('INTERNAL', 500, m)`），直接复用，无需新增。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && npx vitest run test/regcode-core.test.ts`
Expected: PASS 全绿。`npx tsc -p tsconfig.json --noEmit` 通过。

- [ ] **Step 5: Commit**

```bash
git add server/src/core/regcodes.ts server/src/http/errors.ts server/test/regcode-core.test.ts
git commit -m "feat: regcode core — apply/verify/status/revoke with sticky gate and pre-tx occupancy check"
```

---

### Task 3: registerAgent DB 码分支 + sticky 收口 + role='human'

**Files:**
- Modify: `server/src/core/agents.ts:27-38`（归属判定）、`agents.ts:57-61`（role 落库）
- Test: `server/test/reg-codes.test.ts`（扩展既有文件，勿动既有用例）

**Interfaces:**
- Consumes: Task 1 的 `registration_codes` 表；Task 2 无依赖
- Produces: `registerAgent` 新语义——DB 未吊销码命中 → `owner=码.owner_agent_id`，且 `agent_id===owner` 时 `role='human'`；公开码与 `ALLOW_OPEN_REGISTRATION` 均受 sticky 门

- [ ] **Step 1: 写失败测试**

在 `server/test/reg-codes.test.ts` 末尾追加（沿用该文件既有的 db/cfg 构造方式；若签名不同，以"fresh db + loadConfig({REGISTRATION_CODE:'x'})"自建）：

```ts
// —— 邮箱自助码分支（spec §3，v9）——
describe('registerAgent DB regcode branch', () => {
  const setup = () => {
    const cfg = loadConfig({ REGISTRATION_CODE: 'x', PORT: '0' } as never)
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'rdb-')), 't.db')); migrate(db)
    return { cfg, db }
  }
  const insCode = (db: any, code: string, owner: string) =>
    db.prepare(`INSERT INTO registration_codes (code, owner_agent_id, email_norm, created_at) VALUES (?,?,'a@b.c','2026-01-01T00:00:00Z')`).run(code, owner)

  it('DB 码命中 → owner=码 owner；agent_id===owner → role=human；伪码 403', () => {
    const { cfg, db } = setup(); insCode(db, 'al_reg_good', 'kt.human')
    const out = registerAgent(db, cfg, { agent_id: 'kt.human', registration_code: 'al_reg_good' })
    expect(out.agent.owner).toBe('kt.human'); expect(out.agent.role).toBe('human')
    const a = registerAgent(db, cfg, { agent_id: 'kt.bot', registration_code: 'al_reg_good' })
    expect(a.agent.owner).toBe('kt.human'); expect(a.agent.role).toBe('agent')
    // r2-N1：DB 发过码（未吊销存在）→ sticky 门在公开码分支之前，伪码走 registrationClosed（消息 'registration requires …'），不是 forbidden('invalid registration code')
    expect(() => registerAgent(db, cfg, { agent_id: 'x.y', registration_code: 'al_reg_bad' })).toThrowError(/registration requires/)
  })
  it('已吊销 DB 码不认 → 403（sticky：仍 registrationClosed）', () => {
    const { cfg, db } = setup()
    insCode(db, 'al_reg_r', 'kt.human')
    db.prepare(`UPDATE registration_codes SET revoked_at='2026-01-01T00:00:00Z' WHERE code='al_reg_r'`).run()
    expect(() => registerAgent(db, cfg, { agent_id: 'kt.bot', registration_code: 'al_reg_r' })).toThrowError(/registration requires/)
  })
  it('优先级：DB 码存在时 env 分码不参与归属（DB 优先）', () => {
    const cfg = loadConfig({ REGISTRATION_CODE: 'x', AGENTLINK_REG_CODES: 'kt.human:envcode', PORT: '0' } as never)
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'rdb-')), 't.db')); migrate(db)
    insCode(db, 'al_reg_db', 'other.human')
    const out = registerAgent(db, cfg, { agent_id: 'a.bot', registration_code: 'al_reg_db' })
    expect(out.agent.owner).toBe('other.human')
  })
  it('sticky 收口（r4-M1）：env 分码空 + DB 发过码（含已吊销）→ 公开码与 ALLOW_OPEN 均闭门', () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'rdb-')), 't.db')); migrate(db)
    insCode(db, 'al_reg_s', 'kt.human')
    db.prepare(`UPDATE registration_codes SET revoked_at='2026-01-01T00:00:00Z' WHERE code='al_reg_s'`).run() // 全部吊销
    // 公开码：旧实现 cfg.registrationCode 命中即放行 → 应 403（r1-C5：断言按消息文本，错误码 REGISTRATION_CLOSED 不出现在 message 里）
    const cfgPub = loadConfig({ REGISTRATION_CODE: 'pub', PORT: '0' } as never)
    expect(() => registerAgent(db, cfgPub, { agent_id: 'a.bot', registration_code: 'pub' })).toThrowError(/registration requires/)
    // ALLOW_OPEN：旧实现无码放行 → 应 403
    const cfgOpen = loadConfig({ ALLOW_OPEN_REGISTRATION: 'true', PORT: '0' } as never)
    expect(() => registerAgent(db, cfgOpen, { agent_id: 'a.bot' })).toThrowError(/registration requires/)
    // 同库从未发码 → ALLOW_OPEN 正常放行（门只挡发过码的库）
    const db2 = openDb(join(mkdtempSync(join(tmpdir(), 'rdb-')), 't.db')); migrate(db2)
    const out = registerAgent(db2, cfgOpen, { agent_id: 'a.bot' })
    expect(out.agent.owner).toBe('') // r1-M3：humanIds 未配 → defaultOwner=null → owner 落 ''
    // 显式钉死：无码 + 无公开码 + 无 ALLOW_OPEN → 一律 closed（r1 minor）
    const cfgNone = loadConfig({ REGISTRATION_CODE: '', PORT: '0' } as never)
    expect(() => registerAgent(db2, cfgNone, { agent_id: 'b.bot' })).toThrowError(/registration requires/)
  })
})
```

（import 若缺：`loadConfig`、`openDb/migrate`、`mkdtempSync/tmpdir/join`——照文件头既有 import 风格补。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run test/reg-codes.test.ts`
Expected: 新用例 FAIL——DB 码分支不存在（`al_reg_good` 报 invalid registration code）、sticky 两处放行（不 throw）

- [ ] **Step 3: 实现**

`agents.ts` 归属判定（27-38 行区域）整体替换为：

```ts
  // 归属判定（spec §1.5 + regcode v9 §3）：DB 未吊销码优先——码即归属，agent_id==owner 则该 agent 是 human；
  // 次选 env 分码；公开码回退与 ALLOW_OPEN 共用 sticky 门（env 分码空 且 DB 从未发过码，COUNT(*) 含已吊销，r4-M1）
  let owner: string
  let role: string = 'agent'
  const dbCode = input.registration_code
    ? db.prepare('SELECT owner_agent_id FROM registration_codes WHERE code=? AND revoked_at IS NULL').get(input.registration_code) as { owner_agent_id: string } | undefined
    : undefined
  if (dbCode) {
    owner = dbCode.owner_agent_id
    if (input.agent_id === owner) role = 'human'
  } else if (cfg.regCodes.size) {
    owner = cfg.regCodes.get(input.registration_code ?? '') ?? ''
    if (!owner) throw Errors.forbidden('invalid registration code')
  } else {
    const issued = (db.prepare('SELECT COUNT(*) c FROM registration_codes').get() as { c: number }).c > 0
    if (cfg.registrationCode && !issued) {
      if (input.registration_code !== cfg.registrationCode) throw Errors.forbidden('invalid registration code')
      owner = cfg.defaultOwner ?? ''
    } else if (cfg.allowOpenRegistration && !issued) {
      owner = cfg.defaultOwner ?? ''
    } else throw Errors.registrationClosed()
  }
```

同函数 57 行 `const agent: Agent = { … role: 'agent', owner }` 改 `role`；61 行 INSERT 的 `'agent'` 参数改 `role`。**注意 DB 码分支的占用检查时序**：`agent_id already taken` 检查在归属判定之后（40 行）不变——DB 码注册自己的 owner id 时该 id 必未占用（Task 2 verify 已挡），无冲突。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && npx vitest run test/reg-codes.test.ts test/register.test.ts test/identity-core.test.ts`
Expected: PASS（新用例 + 既有注册/env 分码无回归）。

- [ ] **Step 5: Commit**

```bash
git add server/src/core/agents.ts server/test/reg-codes.test.ts
git commit -m "feat: registerAgent DB regcode branch — ownership by code, role=human, sticky gate for public/open"
```

---

### Task 4: config SMTP + 限流项 + ws-server helper 注入口 + nodemailer

**Files:**
- Modify: `server/package.json`（dependencies 加 `"nodemailer": "^6.9.0"`）
- Modify: `server/src/config.ts`（rate 三项、smtp 块、`smtpTransport` 工厂）
- Modify: `server/src/core/ratelimit.ts`（三个 check + email 键 1h 惰性清理）
- Modify: `server/test/helpers/ws-server.ts`（第二参 opts.smtpTransport）
- Test: `server/test/regcode-config.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2 的 `MailTransport`
- Produces:
  - `Config` 增 `rate.regcodeApplyIpPerHour: number; rate.regcodeApplyEmailPerHour: number; rate.regcodeVerifyIpPerHour: number`（env `RATE_LIMIT_REGCODE_APPLY_IP=3` `RATE_LIMIT_REGCODE_APPLY_EMAIL=2` `RATE_LIMIT_REGCODE_VERIFY_IP=10`）
  - `Config` 增 `smtpTransport: () => MailTransport | null`（SMTP_* 全配 → nodemailer transporter；缺任一 → null）
  - `RateLimiter.checkRegcodeApplyIp(ip: string): void; checkRegcodeApplyEmail(emailNorm: string): void; checkRegcodeVerifyIp(ip: string): void`
  - `startWsServer(env, opts?: { smtpTransport?: import('../../src/core/regcodes.js').MailTransport | null })`

- [ ] **Step 1: 写失败测试**

```ts
// server/test/regcode-config.test.ts —— SMTP 工厂 + 限流（spec §4/§5）
import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config.js'
import { RateLimiter } from '../src/core/ratelimit.js'

describe('config smtp', () => {
  it('SMTP_* 全配 → 工厂非 null；缺任一 → null', () => {
    const full = loadConfig({ SMTP_HOST: 'smtpdm.aliyun.com', SMTP_PORT: '465', SMTP_USER: 'no-reply@im.example.com', SMTP_PASSWORD: 'p', SMTP_FROM: 'no-reply@im.example.com' } as never)
    expect(full.smtpTransport()).not.toBeNull()
    const noPass = loadConfig({ SMTP_HOST: 'h', SMTP_USER: 'u' } as never)
    expect(noPass.smtpTransport()).toBeNull()
    expect(loadConfig({}).smtpTransport()).toBeNull()
    expect(full.rate.regcodeApplyIpPerHour).toBe(3); expect(full.rate.regcodeApplyEmailPerHour).toBe(2); expect(full.rate.regcodeVerifyIpPerHour).toBe(10)
  })
  it('env 可覆盖限流配额', () => {
    const cfg = loadConfig({ RATE_LIMIT_REGCODE_APPLY_EMAIL: '5' } as never)
    expect(cfg.rate.regcodeApplyEmailPerHour).toBe(5)
  })
})

describe('RateLimiter regcode', () => {
  it('apply email 2/h：第 3 次 429；同配额 IP 桶独立', () => {
    const l = new RateLimiter(loadConfig({} as never).rate)
    l.checkRegcodeApplyEmail('a@b.c'); l.checkRegcodeApplyEmail('a@b.c')
    expect(() => l.checkRegcodeApplyEmail('a@b.c')).toThrowError(/429|rate/i)
    l.checkRegcodeApplyIp('1.2.3.4') // 独立桶
  })
  it('email 键 1h 内不被惰性清理、超 1h 被清（r2-N2：注入时钟钉死 cutoff，改 2min 清理必挂）', () => {
    let t = 1_700_000_000_000
    const l = new RateLimiter(loadConfig({} as never).rate, () => t)
    l.checkRegcodeApplyEmail('seed@x.y') // 制造 seen 记录
    for (let i = 0; i < 2100; i++) l.checkRegcodeApplyEmail(`k${i}@x.y`) // 撑过 2000 阈值，触发惰性清理
    expect((l as any).buckets.has('rge:seed@x.y')).toBe(true) // 时钟未动：1h 内不得清（2min cutoff 会在此挂）
    t += 3600_000 + 1 // 推进 1h+1ms：seed 已出 cutoff
    l.checkRegcodeApplyEmail('trig@x.y') // 再触发 sweep
    expect((l as any).buckets.has('rge:seed@x.y')).toBe(false) // 超 1h 被清
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run test/regcode-config.test.ts`
Expected: FAIL——`smtpTransport` 不在 Config 上 / `checkRegcodeApplyEmail` 不是函数

- [ ] **Step 3: 实现**

1. `cd server && npm i nodemailer@^6 && npm i -D @types/nodemailer`
2. `config.ts`：`Config` 接口 rate 行追加三项；新增字段 `smtpTransport: () => MailTransport | null`（`import type { MailTransport } from './core/regcodes.js'`——config→core 类型引用仅 type，无环）。`loadConfig` 内：

```ts
    rate: {
      // …既有项不动…
      regcodeApplyIpPerHour: Number(env.RATE_LIMIT_REGCODE_APPLY_IP ?? 3),
      regcodeApplyEmailPerHour: Number(env.RATE_LIMIT_REGCODE_APPLY_EMAIL ?? 2),
      regcodeVerifyIpPerHour: Number(env.RATE_LIMIT_REGCODE_VERIFY_IP ?? 10),
    },
    // SMTP 工厂（spec §5）：任一 SMTP_* 缺失 → null（apply 503）；465 隐式 TLS
    smtpTransport: () => {
      const host = env.SMTP_HOST, user = env.SMTP_USER, pass = env.SMTP_PASSWORD
      if (!host || !user || !pass) return null
      const from = env.SMTP_FROM || user
      const t = nodemailer.createTransport({ host, port: Number(env.SMTP_PORT ?? 465), secure: Number(env.SMTP_PORT ?? 465) === 465, auth: { user, pass } }) // nodemailer 为顶部静态导入（r1-M1）
      return { sendMail: (o) => t.sendMail({ from, to: o.to, subject: o.subject, text: o.text }) }
    },
```

config.ts **顶部加静态导入**（r1-M1：ESM 下运行时 `require()` 直接崩，必须静态导入；nodemailer 是 CJS 包，NodeNext 默认导出互操作可用）：

```ts
import nodemailer from 'nodemailer' // 唯一新运行时依赖（spec §1）；静态导入（r1-M1）
```

仅当宿主进程缺 SMTP env 时工厂才走到 `return null`，静态导入在测试环境也无副作用（不建连接）。
3. `ratelimit.ts` 构造函数签名改为（r3-P2：正式代码改动，非注释；第二参可选，既有单参调用零破坏）：

```ts
  constructor(private rate: Config['rate'], private now: () => number = Date.now) {} // now 可注入——sweep cutoff 可测（对齐 SlidingWindow:20 先例）
```

4. `ratelimit.ts` 末尾追加（feedSeen 同款，cutoff 1h；sweep 内用 `this.now()`）：

```ts
  // regcode 匿名接口（spec §4）：email 键匿名可控，惰性清理思路同 feed 但 cutoff ≥ 1h（r3-m3：
  // 2 分钟清理会误删 1h 窗口内桶，放大配额）。r2-N2：cutoff 行为用注入时钟钉死
  // （对齐 SlidingWindow 的 now 注入先例）
  private regcodeSeen = new Map<string, number>()
  private sweep(key: string): void {
    this.regcodeSeen.set(key, this.now())
    if (this.regcodeSeen.size > 2000) {
      const cutoff = this.now() - 3600_000
      for (const [k, t] of this.regcodeSeen) if (t < cutoff) { this.regcodeSeen.delete(k); this.buckets.delete(k) }
    }
  }
  // 注（r1 minor）：rga-IP/rgv-IP 键非匿名可控，不进 sweep 也无放大风险，但一并挂 regcodeSeen
  // 不会错——保持仅 email 键 sweep，IP 键随进程生命周期存留（与既有 feed 键同待遇）
  checkRegcodeApplyIp(ip: string) { this.check(`rga:${ip}`, this.rate.regcodeApplyIpPerHour, 'regcode-apply-ip', 3600) }
  checkRegcodeApplyEmail(emailNorm: string) { this.sweep(`rge:${emailNorm}`); this.check(`rge:${emailNorm}`, this.rate.regcodeApplyEmailPerHour, 'regcode-apply-email', 3600) }
  checkRegcodeVerifyIp(ip: string) { this.check(`rgv:${ip}`, this.rate.regcodeVerifyIpPerHour, 'regcode-verify-ip', 3600) }
```

5. `ws-server.ts` 签名改 `startWsServer(env: Record<string,string> = {}, opts: { smtpTransport?: MailTransport | null } = {})`，`loadConfig` 后插 `if (opts.smtpTransport !== undefined) cfg.smtpTransport = () => opts.smtpTransport!`（`import type { MailTransport } from '../../src/core/regcodes.js'`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && npx vitest run test/regcode-config.test.ts test/ratelimit.test.ts`
Expected: PASS。`npx tsc -p tsconfig.json --noEmit` 通过。

- [ ] **Step 5: Commit**

```bash
git add server/package.json server/package-lock.json server/src/config.ts server/src/core/ratelimit.ts server/test/helpers/ws-server.ts server/test/regcode-config.test.ts
git commit -m "feat: smtp transport factory + regcode rate limits (1h email-key sweep) + test injection"
```

---

### Task 5: REST 路由 /v1/regcode/*（apply/verify/status/revoke）

**Files:**
- Create: `server/src/http/routes/regcode.ts`
- Modify: `server/src/http/app.ts`（`if (deps.db)` 块内挂载）
- Test: `server/test/regcode-routes.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2 core 五函数、Task 4 limiter 三方法与 `cfg.smtpTransport`
- Produces: `export function registerRegcodeRoutes(app: FastifyInstance, deps: { db: Db; cfg: Config; limiter: RateLimiter }): void`；路由 `POST /v1/regcode/apply`(204/400/429/500/503)、`POST /v1/regcode/verify`(200/404/409/429)、`GET /v1/regcode/status`(200)、`DELETE /v1/regcode/:code`(204/403)、`POST /v1/regcode/revoke-by-owner`(204/403)

- [ ] **Step 1: 写失败测试**

```ts
// server/test/regcode-routes.test.ts —— 路由行为 + admin 鉴权 + 限流接线（spec §4）
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startWsServer } from './helpers/ws-server.js'
import type { MailTransport } from '../src/core/regcodes.js'

let srv: Awaited<ReturnType<typeof startWsServer>>
let outbox: { to: string; text: string }[] = []
const smtp: MailTransport = { sendMail: async (o) => { outbox.push({ to: o.to, text: o.text }) } }
const codeFromMail = () => /\b(\d{6})\b/.exec(outbox[outbox.length - 1].text)![1]

// r1-C6：共享 srv 的 apply IP 桶（127.0.0.1，3/h）会被前序用例耗尽，抬高到 99——限流断言只打 email 2/h 桶
beforeAll(async () => { outbox = []; srv = await startWsServer({ ADMIN_TOKEN: 'adm', RATE_LIMIT_REGCODE_APPLY_IP: '99' }, { smtpTransport: smtp }) })
afterAll(async () => { await srv.close() })

describe('regcode routes', () => {
  it('apply 204（恒；不暴露占用）；verify 发码；用码注册 role=human（链路）', async () => {
    srv.mk('kt.human')
    const r = await srv.app.inject({ method: 'POST', url: '/v1/regcode/apply', payload: { email: 'New@Mail.com', human_agent_id: 'zhy.human' } })
    expect(r.statusCode).toBe(204); expect(outbox[0].to).toBe('New@Mail.com')
    const v = await srv.app.inject({ method: 'POST', url: '/v1/regcode/verify', payload: { email: 'new@mail.com', verify_code: codeFromMail() } })
    expect(v.statusCode).toBe(200)
    const code = v.json().registration_code
    const reg = await srv.app.inject({ method: 'POST', url: '/v1/agents', payload: { agent_id: 'zhy.human', registration_code: code } })
    expect(reg.statusCode).toBe(201); expect(reg.json().agent.role).toBe('human'); expect(reg.json().agent.owner).toBe('zhy.human')
  })
  it('apply 形状错 400；SMTP null → 503（独立 srv 实例）；该实例 status=open（HTTP 位面补钉 open 态，r4-M2）', async () => {
    const s2 = await startWsServer({}, { smtpTransport: null })
    try {
      expect((await s2.app.inject({ method: 'POST', url: '/v1/regcode/apply', payload: { email: 'bad', human_agent_id: 'a.b' } })).statusCode).toBe(400)
      expect((await s2.app.inject({ method: 'POST', url: '/v1/regcode/apply', payload: { email: 'a@b.c', human_agent_id: 'a.b' } })).statusCode).toBe(503)
      expect((await s2.app.inject({ method: 'GET', url: '/v1/regcode/status' })).json()).toEqual({ mode: 'open' })
    } finally { await s2.close() }
  })
  it('verify 404（错码/无记录）与 409（占用）', async () => {
    await srv.app.inject({ method: 'POST', url: '/v1/regcode/apply', payload: { email: 'o@p.q', human_agent_id: 'kt.human' } }) // kt.human 已注册
    expect((await srv.app.inject({ method: 'POST', url: '/v1/regcode/verify', payload: { email: 'o@p.q', verify_code: '000001' } })).statusCode).toBe(404)
    const v = await srv.app.inject({ method: 'POST', url: '/v1/regcode/verify', payload: { email: 'o@p.q', verify_code: codeFromMail() } })
    expect(v.statusCode).toBe(409); expect(v.json().error.code).toBe('AGENT_ID_TAKEN')
    expect((await srv.app.inject({ method: 'POST', url: '/v1/regcode/verify', payload: { email: 'none@x.y', verify_code: '123456' } })).statusCode).toBe(404)
  })
  it('status 三态：本 srv（env 分码空、已发码）→ code（依赖首个用例为 zhy.human 发的未吊销码——vitest 默认顺序执行，依赖显式声明 r2-N7）', async () => {
    expect((await srv.app.inject({ method: 'GET', url: '/v1/regcode/status' })).json()).toEqual({ mode: 'code' })
  })
  it('吊销：x-admin-token 鉴权恒 403；DELETE 幂等 204；revoke-by-owner 204；吊销后码 403、status 仍 code（sticky）', async () => {
    await srv.app.inject({ method: 'POST', url: '/v1/regcode/apply', payload: { email: 'r@s.t', human_agent_id: 'rev.human' } })
    const code = (await srv.app.inject({ method: 'POST', url: '/v1/regcode/verify', payload: { email: 'r@s.t', verify_code: codeFromMail() } })).json().registration_code
    expect((await srv.app.inject({ method: 'DELETE', url: `/v1/regcode/${code}` })).statusCode).toBe(403) // 无头
    expect((await srv.app.inject({ method: 'DELETE', url: `/v1/regcode/${code}`, headers: { 'x-admin-token': 'wrong' } })).statusCode).toBe(403)
    expect((await srv.app.inject({ method: 'DELETE', url: `/v1/regcode/${code}`, headers: { 'x-admin-token': 'adm' } })).statusCode).toBe(204)
    expect((await srv.app.inject({ method: 'DELETE', url: `/v1/regcode/${code}`, headers: { 'x-admin-token': 'adm' } })).statusCode).toBe(204) // 幂等
    expect((await srv.app.inject({ method: 'POST', url: '/v1/agents', payload: { agent_id: 'rev.bot', registration_code: code } })).statusCode).toBe(403)
    expect((await srv.app.inject({ method: 'POST', url: '/v1/regcode/revoke-by-owner', headers: { 'x-admin-token': 'adm' }, payload: { owner_agent_id: 'nobody' } })).statusCode).toBe(204)
    expect((await srv.app.inject({ method: 'GET', url: '/v1/regcode/status' })).json()).toEqual({ mode: 'code' }) // sticky
  })
  it('apply 限流：email 2/h 接线——循环 apply→verify→再 apply 后 429 封顶（spec §7；IP 桶已在本 srv env 抬高到 99，不参与断言）', async () => {
    const email = 'limited@x.y'
    expect((await srv.app.inject({ method: 'POST', url: '/v1/regcode/apply', payload: { email, human_agent_id: 'lim.human' } })).statusCode).toBe(204)
    expect((await srv.app.inject({ method: 'POST', url: '/v1/regcode/verify', payload: { email, verify_code: '000001' } })).statusCode).toBe(404) // verify 不占 apply email 桶
    expect((await srv.app.inject({ method: 'POST', url: '/v1/regcode/apply', payload: { email, human_agent_id: 'lim.human' } })).statusCode).toBe(204) // 再 apply（覆盖 pending）
    expect((await srv.app.inject({ method: 'POST', url: '/v1/regcode/apply', payload: { email, human_agent_id: 'lim.human' } })).statusCode).toBe(429) // 2/h 封顶
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run test/regcode-routes.test.ts`
Expected: FAIL——404 route not found（/v1/regcode/apply 未注册）

- [ ] **Step 3: 实现**

新建 `server/src/http/routes/regcode.ts`：

```ts
// 邮箱自助注册码路由（spec §4）：apply/verify/status 无鉴权；吊销走 x-admin-token（market.ts 先例，恒 403）
import type { FastifyInstance } from 'fastify'
import type { Db } from '../../db/sqlite.js'
import type { Config } from '../../config.js'
import type { RateLimiter } from '../../core/ratelimit.js'
import { Errors } from '../errors.js'
import { clientIp } from '../client-ip.js'
import { applyRegcode, verifyRegcode, regcodeStatus, revokeRegcode, revokeByOwner, normalizeEmail } from '../../core/regcodes.js'

const adminGuard = (cfg: Config, req: { headers: Record<string, unknown> }): void => {
  const token = req.headers['x-admin-token']
  if (!cfg.adminToken || token !== cfg.adminToken) throw Errors.forbidden('invalid admin token')
}

export function registerRegcodeRoutes(app: FastifyInstance, deps: { db: Db; cfg: Config; limiter: RateLimiter }): void {
  app.post('/v1/regcode/apply', { schema: { body: { type: 'object', required: ['email', 'human_agent_id'], additionalProperties: false, properties: {
    email: { type: 'string', maxLength: 254 }, human_agent_id: { type: 'string', maxLength: 32 } } } } }, async (req, reply) => {
    const body = req.body as { email: string; human_agent_id: string }
    // r3-P4（声明为刻意）：限流在 core 形状校验之前——非法形状也耗 IP 桶（自我 DoS 无实害，
    // 且先限流可挡匿名滥用面；与 register 路由"先限流后校验"同序）；email 键仅在可归一化时计
    const norm = normalizeEmail(body.email)
    if (norm) deps.limiter.checkRegcodeApplyEmail(norm)
    deps.limiter.checkRegcodeApplyIp(clientIp(req, deps.cfg.trustedProxies))
    await applyRegcode(deps.db, body, deps.cfg.smtpTransport())
    return reply.status(204).send()
  })
  app.post('/v1/regcode/verify', { schema: { body: { type: 'object', required: ['email', 'verify_code'], additionalProperties: false, properties: {
    email: { type: 'string', maxLength: 254 }, verify_code: { type: 'string', maxLength: 6 } } } } }, async (req) => {
    deps.limiter.checkRegcodeVerifyIp(clientIp(req, deps.cfg.trustedProxies))
    return verifyRegcode(deps.db, req.body as { email: string; verify_code: string }, deps.cfg.smtpTransport())
  })
  app.get('/v1/regcode/status', async () => ({ mode: regcodeStatus(deps.db, deps.cfg) }))
  app.delete('/v1/regcode/:code', async (req, reply) => {
    adminGuard(deps.cfg, req)
    revokeRegcode(deps.db, (req.params as { code: string }).code)
    return reply.status(204).send()
  })
  app.post('/v1/regcode/revoke-by-owner', { schema: { body: { type: 'object', required: ['owner_agent_id'], additionalProperties: false, properties: { owner_agent_id: { type: 'string', maxLength: 32 } } } } }, async (req, reply) => {
    adminGuard(deps.cfg, req)
    revokeByOwner(deps.db, (req.body as { owner_agent_id: string }).owner_agent_id)
    return reply.status(204).send()
  })
}
```

`app.ts`：import 行加 `import { registerRegcodeRoutes } from './routes/regcode.js'`；`if (deps.db)` 块内（`registerAgentsRoutes` 之后任意位置）加 `registerRegcodeRoutes(app, { db: deps.db, cfg: deps.cfg, limiter })`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && npx vitest run test/regcode-routes.test.ts`
Expected: PASS 6/6。跑 `npx vitest run` 全量，确认 371+ 基线无回归。

- [ ] **Step 5: Commit**

```bash
git add server/src/http/routes/regcode.ts server/src/http/app.ts server/test/regcode-routes.test.ts
git commit -m "feat: /v1/regcode routes — apply/verify/status public, revoke via x-admin-token"
```

---

### Task 6: 前端 —— onboarding.html 运行时切换 + auth-md 文案 + 落地页表单

**Files:**
- Modify: `scripts/build-onboarding-html.mjs`（注入公开码标记 + 运行时切换脚本——`web/onboarding.html` 是 .gitignore:12 的**构建产物**，手改会被重建冲掉，r1-M4；本任务结束时本地重建一次供 Step 5 冒烟，不入库）
- Modify: `server/src/http/auth-md.ts:29`（公开码自述改三态中性）
- Modify: `web/landing/index.html`（顶部申请 section + 带码安装命令 + 复制按钮）
- Modify: `web/onboarding.md` / `web/onboarding.en.md`（公开码段占位说明，Step 2）
- Test: 手工验证步骤（见 Step 5）+ `server/test/regcode-routes.test.ts` 已覆盖 API 面

**Interfaces:**
- Consumes: `GET /v1/regcode/status` → `{mode}`、`POST /v1/regcode/apply`、`POST /v1/regcode/verify`（同源相对路径）
- Produces: 无代码接口；纯静态前端

- [ ] **Step 1: build 脚本注入公开码标记 + 运行时切换脚本（r1-M4）**

`scripts/build-onboarding-html.mjs` 中 `const html = \`<!doctype html>…\`` 模板拼装完成后、`writeFileSync` 之前，加两段后处理（码值为空时跳过标记，防 `split('')`）：

```js
// regcode 运行时切换（spec §6）：把注入的公开码文本包上标记，页面加载后按 /v1/regcode/status 决定去留
const markPublicCode = (h, code) => code
  ? h.split(esc(code)).join(`<span class="reg-public-code">${esc(code)}</span>`)
  : h
const statusScript = `
<script>
// 运行时按服务器注册码政策切换（spec §6）：静态注入的公开码仅在 open 态可信
fetch('/v1/regcode/status').then(r => r.json()).then(({ mode }) => {
  if (mode === 'open') return
  document.querySelectorAll('.reg-public-code').forEach(el => { el.hidden = true })
  document.querySelectorAll('main').forEach(m => {
    const hint = document.createElement('p')
    hint.className = 'reg-hint'
    // mode==='code'（含 sticky 关停）→ 索码文案；closed → 联系管理员（r1-M6 closed 态分支）
    hint.textContent = mode === 'code'
      ? '注册码未公开：向你的主人索取，或在落地页用邮箱自助申请。'
      : '注册已关闭：请联系管理员开通。'
    m.prepend(hint)
  })
}).catch(() => {})
</script>`
const final = markPublicCode(html, code).replace('</body>', `${statusScript}\n</body>`)
```

（`writeFileSync` 改写 `final`。）所有动态文案一律 `textContent`/DOM 赋值，无 innerHTML（r4-m5 沿用）。本地重建冒烟：`REGISTRATION_CODE=demo-code-xyz node scripts/build-onboarding-html.mjs && grep -c reg-public-code web/onboarding.html`（Expected: ≥2——中英两容器各至少一处），产物**不 git add**（gitignored）。

- [ ] **Step 2: onboarding.md 注册示例加政策说明行（spec §6 文档链路；r2-N3）**

**保留** `"registration_code":"{{REG_CODE}}"` 占位不动（open 态逃生门靠它注入公开码，spec §8；code 态由 Step 1 运行时脚本隐藏注入值并换提示文案，两层各司其职）。仅在注册示例代码块**下方**（两个语言版本同改，`grep -n 'REG_CODE' web/onboarding.md web/onboarding.en.md` 定位）加一行说明——注意行内**不得出现字面 `{{REG_CODE}}`**（会被 build 替换成真码）：

> 中文版：`> 注册码政策以 GET /v1/regcode/status 为准：open 态本示例中的码即公开码；code 态向你的主人索取，或在落地页用邮箱自助申请；closed 态联系管理员。`
> 英文版：`> Registration-code policy is defined by GET /v1/regcode/status: in open mode the code in the example above is the public code; in code mode ask your owner or self-apply on the landing page; in closed mode contact the admin.`

- [ ] **Step 3: auth-md.ts 三态中性文案**

`server/src/http/auth-md.ts` 中「注册码（registration_code）已随本服务器接入指南公开……」整段替换为：

```
- 注册码（registration_code）政策以 `GET {ORIGIN}/v1/regcode/status` 为准：`open` 时注册码已随接入指南公开（`curl {ORIGIN}/onboarding.md` 取示例中的 registration_code）；`code` 时向你的主人索取，或在落地页用邮箱自助申请；`closed` 时联系管理员。
```

- [ ] **Step 4: 落地页申请 section**

`web/landing/index.html` 顶部主 CTA 之后插入（样式类沿用页面既有风格；所有动态回显一律 textContent）：

```html
<section id="regcode-apply">
  <h3>自助申请注册码</h3>
  <form id="rc-form">
    <input id="rc-email" type="email" placeholder="你的邮箱" required maxlength="254">
    <input id="rc-id" placeholder="你的人类 id（如 kt.human）" required maxlength="32" pattern="[a-z0-9][a-z0-9.-]{2,31}">
    <button type="submit">发送验证码</button>
  </form>
  <form id="rc-verify" hidden>
    <input id="rc-code" placeholder="6 位邮箱验证码" required maxlength="6" inputmode="numeric">
    <button type="submit">领取注册码</button>
  </form>
  <p id="rc-out"></p>
  <p id="rc-err"></p>
</section>
<script>
(() => {
  const $ = (id) => document.getElementById(id)
  let email = ''
  $('rc-form').addEventListener('submit', async (e) => {
    e.preventDefault(); email = $('rc-email').value.trim(); $('rc-err').textContent = ''
    const r = await fetch('/v1/regcode/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, human_agent_id: $('rc-id').value.trim() }) })
    if (r.status === 204) { $('rc-verify').hidden = false; $('rc-out').textContent = '验证码已发送——未收到请检查拼写/垃圾箱，10 分钟后可重新申请' }
    else if (r.status === 429) $('rc-err').textContent = '申请过于频繁，请稍后再试'
    else $('rc-err').textContent = '请求失败，请稍后再试'
  })
  $('rc-verify').addEventListener('submit', async (e) => {
    e.preventDefault(); $('rc-err').textContent = ''
    const r = await fetch('/v1/regcode/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, verify_code: $('rc-code').value.trim() }) })
    const j = await r.json().catch(() => null)
    if (r.status === 200 && j) {
      $('rc-out').textContent = '' // 清占位
      const c = document.createElement('code'); c.textContent = j.registration_code
      $('rc-out').append('你的注册码（只显示一次，请保存）：', c)
      // r1-M6：带码安装命令 + 复制按钮（textContent/DOM 构造，无 innerHTML）
      const cmd = document.createElement('code'); cmd.textContent = `im register <agent_id> --code ${j.registration_code}`
      const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = '复制安装命令'
      btn.addEventListener('click', () => { navigator.clipboard?.writeText(cmd.textContent).then(() => { btn.textContent = '已复制' }).catch(() => {}) })
      const p = document.createElement('p'); p.append('让你的 agent 装机：', cmd, ' '); p.append(btn)
      $('rc-out').append(p)
    } else if (j?.error?.code === 'AGENT_ID_TAKEN') $('rc-err').textContent = '该人类 id 已被占用，请换 id 重新申请'
    else $('rc-err').textContent = '验证码错误或已过期，请重试或重新申请'
  })
})()
</script>
```

- [ ] **Step 5: 手工冒烟**

Run（两个终端）: `cd server && DB_PATH=/tmp/rc-e2e.db REGISTRATION_CODE= npx tsx src/index.ts` 然后 `curl -s localhost:8080/v1/regcode/status`（预期 `{"mode":"open"}`——SMTP 未配 apply 会 503 属预期）。`node -e "…" ` 或浏览器打开 `web/landing/index.html` 无法同源 fetch 属预期（同源部署在 165 nginx 下验证，已列部署核查项）。
Expected: status 端点工作；静态页结构无 JS 报错（`node --check` 不适用 HTML，目测 console 无错）。

- [ ] **Step 6: Commit**

```bash
git add scripts/build-onboarding-html.mjs web/onboarding.md web/onboarding.en.md web/landing/index.html server/src/http/auth-md.ts
git commit -m "feat: landing regcode apply form + onboarding runtime status switch + neutral auth-md copy"
```

（`web/onboarding.html` 是 gitignored 构建产物，不 add；部署流程经 build 脚本再生。）

---

### Task 7: E2E 冒烟 + 部署文件

**Files:**
- Test: `server/test/regcode-e2e.test.ts`（新建）
- Modify: `server/.env.example`（若无则创建，追加 SMTP_*/RATE_LIMIT_REGCODE_* 注释块）

**Interfaces:**
- Consumes: Task 1-6 全部
- Produces: 全链路测试 + 部署 env 清单

- [ ] **Step 1: 写失败测试**

```ts
// server/test/regcode-e2e.test.ts —— 全链路：apply→verify→注册→建群；sticky 与吊销在运维位面的复核（spec §7）
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startWsServer } from './helpers/ws-server.js'
import type { MailTransport } from '../src/core/regcodes.js'

let srv: Awaited<ReturnType<typeof startWsServer>>
let outbox: { to: string; text: string }[] = []
const smtp: MailTransport = { sendMail: async (o) => { outbox.push({ to: o.to, text: o.text }) } }
const lastCode = () => /\b(\d{6})\b/.exec(outbox[outbox.length - 1].text)![1]

beforeAll(async () => { outbox = []; srv = await startWsServer({ RATE_LIMIT_REGCODE_APPLY_IP: '99', RATE_LIMIT_REGCODE_APPLY_EMAIL: '10' }, { smtpTransport: smtp }) }) // r2-N5/r3-P5：e2e 不钉配额（routes 测试已钉），IP/email 双桶抬高留 headroom
afterAll(async () => { await srv.close() })

describe('regcode e2e', () => {
  it('申请→验证→注册（human）→用该 human 身份建群', async () => {
    // apply（大小写混写 +tag：归一化作键、原始收件）
    expect((await srv.app.inject({ method: 'POST', url: '/v1/regcode/apply', payload: { email: 'Zhy+tag@Mail.com', human_agent_id: 'zhy.human' } })).statusCode).toBe(204)
    expect(outbox[0].to).toBe('Zhy+tag@Mail.com')
    const v = await srv.app.inject({ method: 'POST', url: '/v1/regcode/verify', payload: { email: 'zhy@mail.com', verify_code: lastCode() } })
    expect(v.statusCode).toBe(200)
    const code = v.json().registration_code
    const reg = await srv.app.inject({ method: 'POST', url: '/v1/agents', payload: { agent_id: 'zhy.human', registration_code: code } })
    expect(reg.statusCode).toBe(201); expect(reg.json().agent.role).toBe('human')
    const tk = reg.json().token
    const bot = await srv.app.inject({ method: 'POST', url: '/v1/agents', payload: { agent_id: 'zhy.bot', registration_code: code } })
    expect(bot.json().agent.owner).toBe('zhy.human') // 同码带 agent
    const g = await srv.app.inject({ method: 'POST', url: '/v1/groups', headers: { authorization: `Bearer ${tk}` }, payload: { name: 'e2e群', members: ['zhy.bot'] } })
    expect(g.statusCode).toBe(201) // human 可建群（M1 语义）
  })
  it('同邮箱二次领取：旧码吊销失效、新码可用（r2-N1 链路语义）', async () => {
    await srv.app.inject({ method: 'POST', url: '/v1/regcode/apply', payload: { email: 'again@x.y', human_agent_id: 'ag.human' } })
    const c1 = (await srv.app.inject({ method: 'POST', url: '/v1/regcode/verify', payload: { email: 'again@x.y', verify_code: lastCode() } })).json().registration_code
    await srv.app.inject({ method: 'POST', url: '/v1/regcode/apply', payload: { email: 'again@x.y', human_agent_id: 'ag.human' } })
    const c2 = (await srv.app.inject({ method: 'POST', url: '/v1/regcode/verify', payload: { email: 'again@x.y', verify_code: lastCode() } })).json().registration_code
    expect((await srv.app.inject({ method: 'POST', url: '/v1/agents', payload: { agent_id: 'ag2.bot', registration_code: c1 } })).statusCode).toBe(403) // 旧码已吊销
    expect((await srv.app.inject({ method: 'POST', url: '/v1/agents', payload: { agent_id: 'ag2.bot', registration_code: c2 } })).statusCode).toBe(201)
  })
  it('audit 全链落库（applied/verified/issued，actor=regcode，邮箱脱敏）', () => {
    const rows = srv.db.prepare(`SELECT event, actor, detail FROM audit_log WHERE event LIKE 'regcode.%' ORDER BY id`).all() as any[]
    expect(rows.some(r => r.event === 'regcode.applied' && r.actor === 'regcode' && JSON.parse(r.detail).email.match(/^[0-9a-f]{12}@/))).toBe(true)
    expect(rows.some(r => r.event === 'regcode.issued')).toBe(true)
    expect(rows.every(r => !JSON.stringify(r.detail).includes('Zhy+tag'))).toBe(true) // 明文邮箱不入审计
  })
})
```

- [ ] **Step 2: 跑测试确认失败→通过的核对**

Run: `cd server && npx vitest run test/regcode-e2e.test.ts`
Expected: 若 Task 1-6 正确则 PASS；任一 FAIL 回到对应 Task 的修复路径（此测试是集成验证，不驱动新实现——写它是为了钉住全链不变式）。

- [ ] **Step 3: 部署 env 清单**

`server/.env.example` 追加（文件不存在则创建，头部注明"复制为 .env 后填写"）：

```bash
# —— 邮箱自助注册码（spec 2026-10-22-email-regcode-design.md §5）——
# SMTP_* 取自 tokeneff portal .env（部署前需用户确认凭据搬运）
SMTP_HOST=smtpdm.aliyun.com
SMTP_PORT=465
SMTP_USER=no-reply@im.example.com
SMTP_FROM=no-reply@im.example.com
SMTP_PASSWORD=
# 限流（每小时）
RATE_LIMIT_REGCODE_APPLY_IP=3
RATE_LIMIT_REGCODE_APPLY_EMAIL=2
RATE_LIMIT_REGCODE_VERIFY_IP=10
```

- [ ] **Step 4: 全量回归**

Run: `cd server && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: 全绿（基线 371 + 本计划新增 ~25 用例）；已知非回归项 `WS_ERR_UNSUPPORTED_MESSAGE_LENGTH` 未处理错误除外（基线即有）。

- [ ] **Step 5: Commit**

```bash
git add server/test/regcode-e2e.test.ts server/.env.example
git commit -m "test: regcode e2e — apply→verify→register→group + audit masking; add env example"
```

- [ ] **Step 6: 部署核查清单落档（r1-M5，承接 spec §8 全部核查项）**

`docs/deploy/regcode-checklist.md`（新建，部署阶段逐项勾销；实现阶段只落档不执行）：

```markdown
# 邮箱自助注册码上线核查（spec 2026-10-22-email-regcode-design.md §8）

上线前：
- [ ] SMTP_PASSWORD 自 /mnt/data/token-efficiency/.env 复制进部署 .env（凭据搬运，需用户确认后才动）
- [ ] 对照 portal 日发量确认 Aliyun DM 发信地址日限额余量（与 portal 共享额度）
- [ ] docker compose build && up -d（schema v9 迁移自动）
- [ ] 165 nginx 静态站对 /v1 的代理可达（onboarding.html 运行时 fetch /v1/regcode/status 同源前提；不同源需加 CORS 声明）
- [ ] REGISTRATION_CODE=demo npm run build:onboarding 重建 onboarding.html 并同步 /var/www/agentlink（经 /tmp+sudo）
上线后：
- [ ] 真邮箱冒烟：申请→验证→注册→建群（落地页表单走一遍）
- [ ] 垃圾箱抽查首发邮件（SPF/DKIM 已配，仍需人眼一次）
逃生门（open 回退，清 registration_codes 全表）：
- [ ] 重跑 build-onboarding-html.mjs 注回公开码再部署
```

Commit: `git add docs/deploy/regcode-checklist.md && git commit -m "docs: regcode deployment checklist (spec §8)"`
