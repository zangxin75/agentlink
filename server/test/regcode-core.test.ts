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
    await applyRegcode(db, { email: 'a@b.c', human_agent_id: 'h1.human' }, t)
    db.prepare(`INSERT INTO registration_codes (code, owner_agent_id, email_norm, created_at) VALUES ('al_reg_a', 'h1.human', 'a@b.c', '2026-01-01T00:00:00Z')`).run()
    await applyRegcode(db, { email: 'a@b.c', human_agent_id: 'h1.human' }, t); await applyRegcode(db, { email: 'a@b.c', human_agent_id: 'h1.human' }, t)
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
    db.prepare(`INSERT INTO registration_codes (code, owner_agent_id, email_norm, created_at) VALUES ('al_reg_old', 'new.human', 'foo@bar.com', '2026-01-01T00:00:00Z')`).run() // 归一化同键（'Foo@Bar.com' verify 的归一化目标）
    db.prepare(`INSERT INTO registration_codes (code, owner_agent_id, email_norm, created_at) VALUES ('al_reg_other', 'new.human', 'other@x.y', '2026-01-01T00:00:00Z')`).run() // 同 owner 不同邮箱 → 不吊销（spec §2：一邮箱一码，同 id 多邮箱可各领）
    const vc = await prep(db, 'Foo@Bar.com')
    const t2 = fakeTransport()
    const out = await verifyRegcode(db, { email: 'Foo@Bar.com', verify_code: vc }, t2) // r3-P1：传原始大小写——顺带钉住"verify 收件人用原始输入"语义（码查询走归一化）
    expect(out.registration_code).toMatch(/^al_reg_[0-9a-f]{24}$/)
    const row = db.prepare(`SELECT * FROM registration_codes WHERE code=?`).get(out.registration_code) as any
    expect(row.owner_agent_id).toBe('new.human'); expect(row.email_norm).toBe('foo@bar.com'); expect(row.revoked_at).toBeNull()
    expect((db.prepare(`SELECT revoked_at FROM registration_codes WHERE code='al_reg_old'`).get() as any).revoked_at).not.toBeNull() // 旧码吊销
    expect((db.prepare(`SELECT revoked_at FROM registration_codes WHERE code='al_reg_other'`).get() as any).revoked_at).toBeNull() // 同 owner 不同邮箱不吊销（spec §2）
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
    const t = fakeTransport(); await applyRegcode(db, { email: 'x@y.z', human_agent_id: 'h.human' }, t)
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
